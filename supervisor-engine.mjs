/**
 * Concrete C8 v2 REST engine client — the {@link RawEngineClient} the
 * single-owner supervisor runtime consumes as its {@link EngineClient} port
 * (issue #156).
 *
 * #154's activation loop deliberately does NOT use the `@camunda8` SDK job
 * worker: the SDK models one poller per type with `maxJobsToActivate =
 * maxParallel − active` and structurally cannot express "global capacity S
 * shared across K types with per-type gating". The supervisor rolls its own race
 * over a NARROW two-call engine surface instead:
 *
 *   - `activate` → `POST <base>/v2/jobs/activation` for exactly ONE type, one
 *     long-poll, resolving 0..`maxJobsToActivate` jobs (0 == the long-poll
 *     expired empty). `timeout` is the SHORT initial lock (the crash-safety net);
 *     `requestTimeout` is how long the call blocks server-side.
 *   - `extendLock` → `PATCH <base>/v2/jobs/{jobKey}/timeout` with `{ timeout }`.
 *     The C8 contract SETs the lock to `ms` from now (a duration-from-now), which
 *     is exactly the supervisor's "extend the winner to the recovery window, then
 *     heartbeat" model — set, not accumulate.
 *
 * This module is the raw-JS analogue of `agentic-endpoint.mjs`: it is Effect-free
 * (the supervisor's `makeEngineClient` lift wraps each method into the Effect
 * port + `SupervisorError` channel) and quarantines undici/`fetch` behind an
 * injectable `fetchImpl`, so it is wire-testable with a fake `fetch` and never
 * needs a live engine to cover its request shape / response mapping. A rejected
 * promise here (network error or non-2xx) surfaces through the port as a
 * `SupervisorError`, which the activation race treats as that poll losing and the
 * dispatch treats as a likely reclaim — never a crash.
 *
 * @typedef {import('./supervisor.dist.js').ActivateRequest} ActivateRequest
 * @typedef {import('./supervisor.dist.js').ActivatedJob} ActivatedJob
 */

/**
 * Normalize a C8 REST base to `<origin>/v2`. The SDK's `restAddress` may or may
 * not already carry the `/v2` API prefix (CAMUNDA_REST_ADDRESS accepts either),
 * so strip a trailing `/v2` (and any trailing slashes) before re-adding exactly
 * one — mirroring the monolith's `normalizeRestBase` + `<base>/v2` convention so
 * the activation calls hit the SAME endpoint the reconcile reader reads from.
 */
export function v2Base(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "").replace(/\/v2$/i, "");
  return `${trimmed}/v2`;
}

/**
 * Build the request headers for an engine call. A ready-made `authHeaders` map
 * (from the activating SDK client's `getAuthHeaders()`, covering OAuth/basic/
 * none) wins over a bare bearer `token`; an empty map means unauthenticated —
 * deliberately no `Authorization` header (a local nano cluster is unauthed).
 * Matches `fetchLinkedResourceContent`'s auth precedence exactly.
 */
function buildHeaders({ token, authHeaders }) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (authHeaders && typeof authHeaders === "object") Object.assign(headers, authHeaders);
  else if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Map one raw v2 activated-job record to the port's {@link ActivatedJob}. Keys are strings in v2. */
function mapJob(raw) {
  const job = {
    jobKey: String(raw.jobKey ?? raw.key ?? ""),
    type: String(raw.type ?? ""),
  };
  const pdk = raw.processDefinitionKey ?? raw.processDefinitionId;
  if (pdk !== undefined && pdk !== null) job.processDefinitionKey = String(pdk);
  if (raw.variables !== undefined) job.variables = raw.variables;
  return job;
}

async function readErrorBody(res) {
  try {
    const text = await res.text();
    return text ? ` — ${text.slice(0, 500)}` : "";
  } catch {
    return "";
  }
}

/**
 * Create the raw C8 v2 engine client.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl          Engine REST base (with or without `/v2`).
 * @param {string} [opts.worker]         Worker id stamped on every activation (required by v2; defaults to `"c8ctl-supervisor"`).
 * @param {string} [opts.token]          Optional bearer token (unauthed when absent and no `authHeaders`).
 * @param {Record<string,string>} [opts.authHeaders] Ready-made auth header map (wins over `token`).
 * @param {typeof fetch} [opts.fetchImpl] Injected `fetch` (defaults to the global; overridden in tests).
 * @param {number} [opts.requestTimeoutSlackMs] Extra ms added to a call's abort budget over its server long-poll (default 5000).
 * @returns {{ activate(req: ActivateRequest): Promise<ReadonlyArray<ActivatedJob>>, extendLock(jobKey: string, ms: number): Promise<void> }}
 */
export function createRawEngineClient(opts = {}) {
  const {
    baseUrl,
    worker = "c8ctl-supervisor",
    token,
    authHeaders,
    fetchImpl = fetch,
    requestTimeoutSlackMs = 5_000,
  } = opts;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createRawEngineClient: `fetchImpl` must be a function (global fetch or an injected fake)");
  }
  const base = v2Base(baseUrl);
  const headers = buildHeaders({ token, authHeaders });

  /**
   * Issue one call with an abort budget. `abortAfterMs <= 0` means no timer
   * (the caller relies purely on the server long-poll / connection).
   */
  async function call(url, init, abortAfterMs) {
    const controller = new AbortController();
    const timer = abortAfterMs > 0 ? setTimeout(() => controller.abort(), abortAfterMs) : null;
    try {
      return await fetchImpl(url, { ...init, headers, signal: controller.signal });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    async activate(req) {
      const body = JSON.stringify({
        type: req.type,
        worker,
        maxJobsToActivate: req.maxJobsToActivate,
        // `timeout` is the SHORT initial lock applied to any returned job.
        timeout: req.lockMs,
        // `requestTimeout` is the server-side long-poll window.
        requestTimeout: req.requestTimeoutMs,
      });
      // Give the abort budget slack over the server long-poll so we don't cancel
      // a still-valid long-poll a hair before the server would answer it.
      const abortAfterMs = req.requestTimeoutMs > 0 ? req.requestTimeoutMs + requestTimeoutSlackMs : 0;
      const res = await call(`${base}/jobs/activation`, { method: "POST", body }, abortAfterMs);
      if (!res || !res.ok) {
        const status = res ? res.status : "?";
        throw new Error(`activate ${req.type}: HTTP ${status} from ${base}/jobs/activation${res ? await readErrorBody(res) : ""}`);
      }
      const json = await res.json();
      const jobs = Array.isArray(json?.jobs) ? json.jobs : Array.isArray(json) ? json : [];
      return jobs.map(mapJob);
    },

    async extendLock(jobKey, ms) {
      const url = `${base}/jobs/${encodeURIComponent(jobKey)}/timeout`;
      const res = await call(url, { method: "PATCH", body: JSON.stringify({ timeout: ms }) }, 15_000);
      if (!res || !res.ok) {
        const status = res ? res.status : "?";
        throw new Error(`extendLock ${jobKey}: HTTP ${status} from ${url}${res ? await readErrorBody(res) : ""}`);
      }
    },
  };
}
