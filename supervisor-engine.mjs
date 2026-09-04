/**
 * Concrete C8 v2 REST engine client — the {@link RawEngineClient} the
 * single-owner supervisor runtime consumes as its {@link EngineClient} port
 * (issue #156).
 *
 * #154's activation loop deliberately does NOT use the `@camunda8` SDK job
 * worker (`createJobWorker`): that convenience loop models one self-driving
 * poller per type with `maxJobsToActivate = maxParallel − active` and cannot
 * express "global capacity S shared across K types with per-type gating". The
 * supervisor rolls its own race over a NARROW single-shot engine surface — but
 * every call on that surface still PREFERS the injected `camunda` SDK client's
 * typed method, hand-rolling REST only as a standalone/wire-test fallback:
 *
 *   - `activate` → the SDK's typed `activateJobs` (operationId `activateJobs` →
 *     `POST <base>/jobs/activation`) for exactly ONE type, one long-poll,
 *     resolving 0..`maxJobsToActivate` jobs (0 == the long-poll expired empty).
 *     `activateJobs` is the SINGLE-SHOT primitive `createJobWorker` is built on;
 *     its input body (`JobActivationRequest`) is 1:1 with ours and its returned
 *     `CancelablePromise.cancel()` aborts the in-flight long-poll, so a losing
 *     `raceAll` fiber interrupts its poll at once. Falls back to the SAME call
 *     issued raw via `fetchImpl` when no SDK client is injected. `timeout` is the
 *     SHORT initial lock (the crash-safety net); `requestTimeout` is how long the
 *     call blocks server-side.
 *   - `extendLock` → the SDK's typed `updateJob` (operationId `updateJob`,
 *     `PATCH <base>/jobs/{jobKey}` with `{ changeset: { timeout } }`) when a
 *     `camunda` SDK client is injected, else the SAME call issued raw via
 *     `fetchImpl` (so the module stays wire-testable without a live client).
 *     The C8 contract SETs the lock to `ms` from now (a duration-from-now), which
 *     is exactly the supervisor's "extend the winner to the recovery window, then
 *     heartbeat" model — set, not accumulate. NOTE: there is no
 *     `/jobs/{jobKey}/timeout` sub-route — that was a drifted URL that 404s on the
 *     engine; the timeout is a `changeset` field on the job resource itself.
 *   - `complete` / `fail` → the SDK's typed `completeJob` / `failJob` (operationIds
 *     `completeJob` → `POST <base>/jobs/{jobKey}/completion`, `failJob` →
 *     `POST <base>/jobs/{jobKey}/failure`) when a `camunda` SDK client is injected,
 *     else the SAME calls issued raw via `fetchImpl` — the settle surface the
 *     supervisor's JobRunner uses once an agent finishes.
 *
 * Every method on this surface (`activate`→`activateJobs`,
 * `extendLock`→`updateJob`, `complete`→`completeJob`, `fail`→`failJob`) PREFERS
 * the injected `camunda` client and only hand-rolls the REST call as a
 * standalone/wire-test fallback; there is no sanctioned raw-only method. This
 * convention is pinned by `supervisor-engine-sdk-preference.test.mjs` — a new
 * engine method that hits a raw route must either prefer an SDK method or be
 * added to that test's raw-only allowlist with a reason.
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
 * True only for a plain object map (rejects `null`, arrays, and exotic objects
 * like `Date`/`Map`). The engine expects `variables`/`customHeaders` to be a
 * key/value map, so anything else is dropped rather than POSTed as a malformed
 * body or surfaced to the runner as an unexpected shape.
 */
function isPlainObjectMap(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
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
  // Settle-path passthrough (issue #156): the runner needs the task headers (to
  // assemble the reserved task envelope + read the `linkName="prompt"` marker),
  // the retry count (to preserve/decrement it on a `fail`, matching the SDK job
  // object), and the process-instance key (audit/logging). These ride opaquely
  // to the runner exactly as the SDK job worker surfaces them.
  if (raw.customHeaders !== undefined && raw.customHeaders !== null && isPlainObjectMap(raw.customHeaders))
    job.customHeaders = raw.customHeaders;
  const rawRetries = raw.retries;
  if (rawRetries !== undefined && rawRetries !== null) {
    const n = Number(rawRetries);
    // Downstream treats retries as a non-negative integer (decremented on fail),
    // so normalize floats/negatives rather than pass a fractional/negative count.
    if (Number.isFinite(n)) job.retries = Math.max(0, Math.trunc(n));
  }
  const pik = raw.processInstanceKey;
  if (pik !== undefined && pik !== null) job.processInstanceKey = String(pik);
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
 * @param {{ activateJobs?: (input: { type: string, worker?: string, maxJobsToActivate: number, timeout: number, requestTimeout?: number }) => (Promise<{ jobs?: object[] }> & { cancel?: () => void }), updateJob?: (req: { jobKey: string, changeset: { timeout: number } }) => Promise<unknown>, completeJob?: (req: { jobKey: string, variables?: object }) => Promise<unknown>, failJob?: (req: { jobKey: string, retries?: number, errorMessage?: string, retryBackOff?: number, variables?: object }) => Promise<unknown> }} [opts.camunda] Optional Camunda SDK client. When present, each engine method prefers its typed SDK method over the raw fetch fallback: `activate`→`activateJobs` (`POST /v2/jobs/activation`, cancelled via the returned `CancelablePromise.cancel()`), `extendLock`→`updateJob` (`PATCH /v2/jobs/{jobKey}` `{ changeset: { timeout } }`), `complete`→`completeJob` (`POST /v2/jobs/{jobKey}/completion`), `fail`→`failJob` (`POST /v2/jobs/{jobKey}/failure`).
 * @returns {{ activate(req: ActivateRequest, signal?: AbortSignal): Promise<ReadonlyArray<ActivatedJob>>, extendLock(jobKey: string, ms: number): Promise<void>, complete(jobKey: string, variables?: object): Promise<void>, fail(jobKey: string, opts?: { retries?: number, errorMessage?: string, retryBackOff?: number, variables?: object }): Promise<void> }}
 */
export function createRawEngineClient(opts = {}) {
  const {
    baseUrl,
    worker = "c8ctl-supervisor",
    token,
    authHeaders,
    fetchImpl = fetch,
    requestTimeoutSlackMs = 5_000,
    camunda,
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
   * (the caller relies purely on the server long-poll / connection). An optional
   * `extSignal` (e.g. the Effect fiber's interruption signal for the `activate`
   * long-poll) also aborts the in-flight fetch, so a losing `raceAll` fiber stops
   * its poll immediately instead of leaking it until the budget timer fires.
   */
  async function call(url, init, abortAfterMs, extSignal) {
    const controller = new AbortController();
    const timer = abortAfterMs > 0 ? setTimeout(() => controller.abort(), abortAfterMs) : null;
    const onExtAbort = () => controller.abort();
    if (extSignal) {
      if (extSignal.aborted) controller.abort();
      else extSignal.addEventListener("abort", onExtAbort, { once: true });
    }
    try {
      const headers = await resolveHeaders();
      return await fetchImpl(url, { ...init, headers, signal: controller.signal });
    } finally {
      if (timer) clearTimeout(timer);
      if (extSignal) extSignal.removeEventListener("abort", onExtAbort);
    }
  }

  return {
    async activate(req, signal) {
      // Prefer the SDK's typed `activateJobs` (operationId `activateJobs` →
      // `POST /v2/jobs/activation`) so the ONE-type long-poll tracks the engine
      // contract instead of a hand-rolled body/URL. The SDK's `createJobWorker`
      // convenience loop can't express the supervisor's global-capacity single
      // race — but `activateJobs` is the SAME single-shot primitive that loop is
      // built on, and its input body (`JobActivationRequest`) is 1:1 with ours.
      // Its `CancelablePromise.cancel()` aborts the in-flight long-poll, so a
      // losing `raceAll` fiber (interruption → `signal.aborted`) stops its poll
      // immediately. Fall back to the SAME call issued raw via `fetchImpl` when no
      // SDK client is injected (keeps this module wire-testable and standalone).
      // `timeout` is the SHORT initial lock applied to any returned job;
      // `requestTimeout` is the server-side long-poll window.
      const input = {
        type: req.type,
        worker,
        maxJobsToActivate: req.maxJobsToActivate,
        timeout: req.lockMs,
        requestTimeout: req.requestTimeoutMs,
      };
      // Give the abort budget slack over the server long-poll so we don't cancel
      // a still-valid long-poll a hair before the server would answer it.
      const abortAfterMs = req.requestTimeoutMs > 0 ? req.requestTimeoutMs + requestTimeoutSlackMs : 0;
      if (camunda && typeof camunda.activateJobs === "function") {
        const p = camunda.activateJobs(input);
        // Wire BOTH cancellation sources onto the CancelablePromise: the external
        // interruption signal (fiber lost the race) and the client-side abort
        // budget (a hung connection past the server window). `cancel()` aborts the
        // SDK's own AbortController, ending the long-poll.
        const cancel = typeof p?.cancel === "function" ? () => p.cancel() : () => {};
        const timer = abortAfterMs > 0 ? setTimeout(cancel, abortAfterMs) : null;
        const onExtAbort = () => cancel();
        if (signal) {
          if (signal.aborted) cancel();
          else signal.addEventListener("abort", onExtAbort, { once: true });
        }
        try {
          const result = await p;
          const jobs = Array.isArray(result?.jobs) ? result.jobs : Array.isArray(result) ? result : [];
          return jobs.map(mapJob);
        } catch (err) {
          throw new Error(`activate ${req.type}: SDK activateJobs failed: ${err?.message ?? err}`, { cause: err });
        } finally {
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onExtAbort);
        }
      }
      const body = JSON.stringify(input);
      const res = await call(`${base}/jobs/activation`, { method: "POST", body }, abortAfterMs, signal);
      if (!res || !res.ok) {
        const status = res ? res.status : "?";
        throw new Error(`activate ${req.type}: HTTP ${status} from ${base}/jobs/activation${res ? await readErrorBody(res) : ""}`);
      }
      const json = await res.json();
      const jobs = Array.isArray(json?.jobs) ? json.jobs : Array.isArray(json) ? json : [];
      return jobs.map(mapJob);
    },

    async extendLock(jobKey, ms) {
      // Prefer the SDK's typed `updateJob` (operationId `updateJob` →
      // `PATCH /v2/jobs/{jobKey}` with `{ changeset: { timeout } }`) so the lock
      // extension tracks the engine contract instead of a hand-rolled URL. Fall
      // back to the SAME call issued raw when no SDK client is injected (keeps
      // this module wire-testable and usable standalone).
      if (camunda && typeof camunda.updateJob === "function") {
        try {
          await camunda.updateJob({ changeset: { timeout: ms }, jobKey: String(jobKey) });
          return;
        } catch (err) {
          throw new Error(`extendLock ${jobKey}: SDK updateJob failed: ${err?.message ?? err}`, { cause: err });
        }
      }
      const url = `${base}/jobs/${encodeURIComponent(jobKey)}`;
      const res = await call(url, { method: "PATCH", body: JSON.stringify({ changeset: { timeout: ms } }) }, 15_000);
      if (!res || !res.ok) {
        const status = res ? res.status : "?";
        throw new Error(`extendLock ${jobKey}: HTTP ${status} from ${url}${res ? await readErrorBody(res) : ""}`);
      }
    },

    // ---- Job completion / failure ------------------------------------------
    // The narrow surface the supervisor's JobRunner needs to SETTLE a job once
    // its agent harness finishes — the analogue of the SDK job object's
    // `job.complete()` / `job.fail()` (which the per-type SDK poller path in
    // `workAgent` still uses). A plain `ActivatedJob` (jobKey/type/variables)
    // carries no settle methods, so the supervisor path settles via these calls.
    // Like `extendLock`, each PREFERS the injected `camunda` SDK client's typed
    // method (`completeJob` / `failJob`) and only hand-rolls the REST call as a
    // standalone/wire-test fallback. Effect-free and wire-testable; a non-2xx /
    // SDK rejection (e.g. a 409 when the lock lapsed and the job was reclaimed)
    // surfaces as a rejected promise for the port to map.

    async complete(jobKey, variables) {
      // Prefer the SDK's typed `completeJob` (operationId `completeJob` →
      // `POST /v2/jobs/{jobKey}/completion` with `{ variables }`) when a `camunda`
      // SDK client is injected, else the SAME call issued raw via `fetchImpl`. The
      // result-variable map the model produced is merged onto the process
      // instance. C8 v2 answers 204 No Content on success.
      const vars = isPlainObjectMap(variables) ? { variables } : {};
      if (camunda && typeof camunda.completeJob === "function") {
        try {
          await camunda.completeJob({ jobKey: String(jobKey), ...vars });
          return;
        } catch (err) {
          throw new Error(`complete ${jobKey}: SDK completeJob failed: ${err?.message ?? err}`, { cause: err });
        }
      }
      const url = `${base}/jobs/${encodeURIComponent(jobKey)}/completion`;
      const res = await call(url, { method: "POST", body: JSON.stringify(vars) }, 15_000);
      if (!res || !res.ok) {
        const status = res ? res.status : "?";
        throw new Error(`complete ${jobKey}: HTTP ${status} from ${url}${res ? await readErrorBody(res) : ""}`);
      }
    },

    async fail(jobKey, opts) {
      // Tolerate a `null` opts the same as `undefined` (mirrors `complete`'s
      // null-safe `variables`), so a caller passing `null` never trips the
      // signature-destructure TypeError.
      const { retries = 0, errorMessage, retryBackOff, variables } = opts || {};
      // Normalize retries to a non-negative integer (mirrors `mapJob`), so a
      // string/float/negative never reaches the engine (or SDK) as an invalid
      // count. `retries > 0` re-queues for another attempt, `retries === 0`
      // raises an incident. Optional fields are omitted when absent so the engine
      // applies its own defaults.
      const nRetries = Number(retries);
      const normRetries = Number.isFinite(nRetries) ? Math.max(0, Math.trunc(nRetries)) : 0;
      const extra = {};
      if (errorMessage !== undefined && errorMessage !== null) extra.errorMessage = String(errorMessage);
      if (Number.isFinite(retryBackOff) && retryBackOff > 0) extra.retryBackOff = retryBackOff;
      if (isPlainObjectMap(variables)) extra.variables = variables;
      // Prefer the SDK's typed `failJob` (operationId `failJob` →
      // `POST /v2/jobs/{jobKey}/failure`) when a `camunda` SDK client is injected,
      // else the SAME call issued raw via `fetchImpl`. C8 v2 answers 204.
      if (camunda && typeof camunda.failJob === "function") {
        try {
          await camunda.failJob({ jobKey: String(jobKey), retries: normRetries, ...extra });
          return;
        } catch (err) {
          throw new Error(`fail ${jobKey}: SDK failJob failed: ${err?.message ?? err}`, { cause: err });
        }
      }
      const url = `${base}/jobs/${encodeURIComponent(jobKey)}/failure`;
      const res = await call(url, { method: "POST", body: JSON.stringify({ retries: normRetries, ...extra }) }, 15_000);
      if (!res || !res.ok) {
        const status = res ? res.status : "?";
        throw new Error(`fail ${jobKey}: HTTP ${status} from ${url}${res ? await readErrorBody(res) : ""}`);
      }
    },
  };
}
