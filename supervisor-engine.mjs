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

/**
 * Map one raw v2 activated-job record to the port's {@link ActivatedJob}. Keys are
 * strings in v2. A record missing `jobKey`/`type` violates the `ActivatedJob`
 * contract (an empty key would produce `PATCH .../jobs//timeout`; an empty type
 * would dispatch a typeless job), so fail the whole activation rather than coerce
 * to `""` — a malformed engine response surfaces as a rejected activate() call.
 */
function mapJob(raw) {
  const rawKey = raw?.jobKey ?? raw?.key;
  const jobKey = rawKey === undefined || rawKey === null ? "" : String(rawKey);
  const rawType = raw?.type;
  const type = rawType === undefined || rawType === null ? "" : String(rawType);
  if (!jobKey || !type) {
    const missing = !jobKey && !type ? "jobKey and type" : !jobKey ? "jobKey" : "type";
    // Summarise the record (keys/type/pdk) — never JSON.stringify the whole raw
    // job, which can carry `variables` (potentially sensitive payload) into
    // logs/error messages.
    const summary =
      raw && typeof raw === "object"
        ? `keys=[${Object.keys(raw).join(",")}] type=${JSON.stringify(rawType)} pdk=${JSON.stringify(
            raw.processDefinitionKey ?? raw.processDefinitionId,
          )}`
        : `type=${typeof raw}`;
    throw new Error(`activate: malformed activated job from engine (missing ${missing}): ${summary}`);
  }
  const job = { jobKey, type };
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
 * @param {Record<string,string>|(() => (Record<string,string>|Promise<Record<string,string>>))} [opts.authHeaders] Ready-made auth header map, OR a resolver invoked per request (so rotating SDK auth — e.g. an OAuth bearer that refreshes — is re-derived each call rather than frozen). Wins over `token`.
 * @param {typeof fetch} [opts.fetchImpl] Injected `fetch` (defaults to the global; overridden in tests).
 * @param {number} [opts.requestTimeoutSlackMs] Extra ms added to a call's abort budget over its server long-poll (default 5000).
 * @returns {{ activate(req: ActivateRequest): Promise<ReadonlyArray<ActivatedJob>>, extendLock(jobKey: string, ms: number): Promise<void>, complete(jobKey: string, variables?: object): Promise<void>, fail(jobKey: string, opts?: { retries?: number, errorMessage?: string, retryBackOff?: number, variables?: object }): Promise<void> }}
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
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new TypeError("createRawEngineClient: `baseUrl` is required (the engine REST base, with or without `/v2`)");
  }
  // Trim before deriving the base: `v2Base` strips trailing `/` and `/v2` but
  // preserves interior/edge whitespace, so a base URL with leading/trailing
  // spaces (e.g. from env/config) would pass the non-empty check yet yield an
  // invalid request URL like `http://engine:8080 /v2/...`.
  const base = v2Base(baseUrl.trim());
  // Auth headers may be a static map OR a resolver function. SDK auth (e.g. an
  // OAuth bearer) rotates on token refresh, so a long-lived client must re-derive
  // headers PER CALL rather than freeze a startup snapshot that silently expires.
  // A static map (or bare token) is resolved once and reused.
  const resolveHeaders =
    typeof authHeaders === "function"
      ? async () => buildHeaders({ token, authHeaders: await authHeaders() })
      : (() => {
          const staticHeaders = buildHeaders({ token, authHeaders });
          return async () => staticHeaders;
        })();

  /**
   * Issue one call with an abort budget. `abortAfterMs <= 0` means no timer
   * (the caller relies purely on the server long-poll / connection).
   */
  async function call(url, init, abortAfterMs) {
    const controller = new AbortController();
    const timer = abortAfterMs > 0 ? setTimeout(() => controller.abort(), abortAfterMs) : null;
    try {
      const headers = await resolveHeaders();
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

    // ---- Job completion / failure ------------------------------------------
    // The narrow surface the supervisor's JobRunner needs to SETTLE a job once
    // its agent harness finishes — the direct-REST analogue of the SDK job
    // object's `job.complete()` / `job.fail()` (which the per-type SDK poller
    // path in `workAgent` still uses). A plain `ActivatedJob` (jobKey/type/
    // variables) carries no settle methods, so the supervisor path completes via
    // these calls instead. Effect-free and wire-testable like `activate` /
    // `extendLock`; a non-2xx (e.g. a 409 when the lock already lapsed and the
    // job was reclaimed) surfaces as a rejected promise for the port to map.

    async complete(jobKey, variables) {
      // `POST <base>/v2/jobs/{jobKey}/completion` with `{ variables }` — the
      // result-variable map the model produced is merged onto the process
      // instance. C8 v2 answers 204 No Content on success.
      const url = `${base}/jobs/${encodeURIComponent(jobKey)}/completion`;
      const body = JSON.stringify(variables && typeof variables === "object" ? { variables } : {});
      const res = await call(url, { method: "POST", body }, 15_000);
      if (!res || !res.ok) {
        const status = res ? res.status : "?";
        throw new Error(`complete ${jobKey}: HTTP ${status} from ${url}${res ? await readErrorBody(res) : ""}`);
      }
    },

    async fail(jobKey, { retries = 0, errorMessage, retryBackOff, variables } = {}) {
      // `POST <base>/v2/jobs/{jobKey}/failure` with `{ retries, errorMessage?,
      // retryBackOff?, variables? }` — `retries > 0` re-queues for another
      // attempt, `retries === 0` raises an incident. Optional fields are omitted
      // when absent so the engine applies its own defaults. C8 v2 answers 204.
      const url = `${base}/jobs/${encodeURIComponent(jobKey)}/failure`;
      const payload = { retries };
      if (errorMessage !== undefined && errorMessage !== null) payload.errorMessage = String(errorMessage);
      if (Number.isFinite(retryBackOff) && retryBackOff > 0) payload.retryBackOff = retryBackOff;
      if (variables && typeof variables === "object") payload.variables = variables;
      const res = await call(url, { method: "POST", body: JSON.stringify(payload) }, 15_000);
      if (!res || !res.ok) {
        const status = res ? res.status : "?";
        throw new Error(`fail ${jobKey}: HTTP ${status} from ${url}${res ? await readErrorBody(res) : ""}`);
      }
    },
  };
}
