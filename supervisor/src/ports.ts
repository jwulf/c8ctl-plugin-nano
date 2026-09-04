/**
 * Injected ports for the single-owner supervisor runtime.
 *
 * Everything the supervisor touches at the edge of the process — the engine's
 * `/v2/jobs/activation` + `UpdateJobTimeout` calls, the deployed-definition
 * reconcile reader, the agent job runner, the agentic connection, and logging —
 * is expressed as a narrow, injectable interface. This is what lets the whole
 * runtime be driven deterministically under Effect's `TestClock` with in-memory
 * fakes, and lets the raw-JS `c8ctl-plugin.js` monolith supply real adapters
 * (its existing keep-alive reader, `createClient()` SDK, `runAgentJob`, etc.)
 * without the supervisor ever importing Node/undici/the SDK directly.
 *
 * Durations crossing the port are plain **milliseconds** (numbers), not
 * `Duration`, so a JS adapter never has to construct an Effect `Duration`.
 */
import type { Effect } from "effect";

/** A single tagged failure surface for every port. Keeps the error channel closed. */
export class SupervisorError extends Error {
  readonly _tag = "SupervisorError";
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SupervisorError";
    this.cause = cause;
  }
}

/** A job as activated from the engine. `variables`/`payload` are opaque passthrough. */
export interface ActivatedJob {
  readonly jobKey: string;
  readonly type: string;
  readonly processDefinitionKey?: string;
  readonly variables?: unknown;
  /**
   * The job's custom headers (BPMN task headers) — opaque passthrough. The agent
   * runner needs these to assemble the reserved task envelope (headers=defaults ←
   * variables=overrides) and to read the `linkName="prompt"` linked-resource
   * marker, exactly as the SDK job worker path does. Absent on a poll that
   * carries no headers.
   */
  readonly customHeaders?: Record<string, unknown>;
  /**
   * The engine-provided retry count. The runner MUST preserve/decrement this when
   * it settles a failure through {@link EngineClient.fail} (a `retries > 0`
   * re-queues, `0` raises an incident) — the direct analogue of the SDK job
   * object's `job.retries`. Absent when the engine did not surface it.
   */
  readonly retries?: number;
  /** The owning process-instance key — surfaced for logging/audit, matching the SDK job. */
  readonly processInstanceKey?: string;
}

/** One per-type activation request. `maxJobsToActivate` is sized per-type to that type's free-slot count (capped by `maxBatchPerType`). */
export interface ActivateRequest {
  readonly type: string;
  /** Batch size for this type — its free-slot count, clamped to `[1, maxBatchPerType]`. */
  readonly maxJobsToActivate: number;
  /** Long-poll request timeout (ms) — how long a single `activation` call blocks. */
  readonly requestTimeoutMs: number;
  /** Short initial lock (ms) applied to any returned job — the crash-safety net. */
  readonly lockMs: number;
}

/**
 * Direct engine calls. Deliberately NOT the `@camunda8` SDK job worker: the SDK
 * models one poller per type with `maxJobsToActivate = maxParallel − active` and
 * structurally cannot express "global capacity S shared across K types with
 * per-type gating". We roll our own loop over this surface instead.
 */
export interface EngineClient {
  /**
   * `POST /v2/jobs/activation` for exactly ONE type. Resolves with between 0 and
   * `maxJobsToActivate` jobs (0 == the long-poll expired with nothing to hand out).
   */
  activate(req: ActivateRequest): Effect.Effect<ReadonlyArray<ActivatedJob>, SupervisorError>;
  /**
   * `UpdateJobTimeout` — SET the job's lock to `ms` from now (the contract is a
   * duration-from-now, so calls set rather than accumulate). Used to extend the
   * winner to the recovery window, then to heartbeat it. A failure here on the
   * winner's first extend means the lock likely raced a reclaim — do not start.
   */
  extendLock(jobKey: string, ms: number): Effect.Effect<void, SupervisorError>;
  /**
   * `POST /v2/jobs/{jobKey}/completion` — SETTLE a job successfully, merging the
   * agent's result `variables` onto the process instance. The supervisor owns the
   * lock lifecycle around the runner; the runner calls this (via its injected
   * settler) when its harness finishes cleanly, the direct-REST analogue of the
   * SDK job object's `job.complete()` the per-type poller path uses. A rejection
   * (e.g. a 409 when the lock already lapsed and the job was reclaimed) surfaces
   * as a {@link SupervisorError} for the runner to map, never a crash.
   */
  complete(jobKey: string, variables?: Record<string, unknown>): Effect.Effect<void, SupervisorError>;
  /**
   * `POST /v2/jobs/{jobKey}/failure` — SETTLE a job as failed. `retries > 0`
   * re-queues for another attempt; `retries === 0` raises an incident. Optional
   * `errorMessage`/`retryBackOff`/`variables` are applied when present. The
   * analogue of the SDK job object's `job.fail()`; a rejection surfaces as a
   * {@link SupervisorError}.
   */
  fail(
    jobKey: string,
    opts?: {
      readonly retries?: number;
      readonly errorMessage?: string;
      readonly retryBackOff?: number;
      readonly variables?: Record<string, unknown>;
    },
  ): Effect.Effect<void, SupervisorError>;
}

/**
 * The deployed-definition reconcile seam (the existing `httpC8RestReader`). A
 * real adapter reuses a keep-alive undici pool and resolves the engine host once
 * (IPv4-first) so the 1 + N crawl is paid at most once per new key, not per pass.
 */
export interface ReconcileReader {
  searchProcessDefinitionKeys(): Effect.Effect<ReadonlyArray<string>, SupervisorError>;
  getProcessDefinitionXml(key: string): Effect.Effect<string, SupervisorError>;
}

/** Scan a BPMN XML string for its agent job-type leaves (from `agentic.mjs`). */
export type ScanAgentLeaves = (xml: string) => ReadonlyArray<{ taskType: string; process: string }>;

/**
 * Runs one activated job to completion (the existing `runAgentJob` harness). The
 * supervisor owns the lock lifecycle around this; the runner just executes.
 */
export interface JobRunner {
  run(job: ActivatedJob): Effect.Effect<void, SupervisorError>;
}

/** Minimal logger, satisfied by the plugin's `getLogger()` or `console`. */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  debug?(msg: string): void;
}

export const noopLogger: Logger = { info: () => {}, warn: () => {}, debug: () => {} };
