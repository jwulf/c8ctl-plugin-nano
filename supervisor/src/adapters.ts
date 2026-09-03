/**
 * Concrete port adapters — the live cut-over seam (issue #156).
 *
 * #154 landed the single-owner runtime as an interface: {@link makeSupervisor}
 * consumes narrow, injectable ports ({@link EngineClient}, {@link
 * ReconcileReader}, {@link JobRunner}, {@link Logger}) so the whole program runs
 * deterministically under `TestClock` with in-memory fakes. #156 wires those
 * ports to the monolith's REAL edges — the direct `/v2/jobs/activation` +
 * `/v2/jobs/{key}/timeout` engine calls, the deployed-definition reconcile
 * reader, the `runAgentJob` harness, and `getLogger()`.
 *
 * This module is the thin, deterministically-testable seam between the two — the
 * exact analogue of `emit.ts` for the {@link AgenticEndpoint}. The raw-JS
 * monolith cannot construct Effect values without importing Effect, and the port
 * methods live in the Effect error channel; so the monolith supplies plain,
 * Effect-free async clients ({@link RawEngineClient}, {@link RawReconcileReader},
 * {@link RawJobRunner}) built against undici/the SDK, and these lifts turn each
 * into the Effect port — mapping a promise rejection into a single tagged {@link
 * SupervisorError} so the supervisor's error channel stays closed and Node/
 * undici/the SDK never leak past the port boundary.
 *
 * Durations crossing the port are plain **milliseconds** (numbers): a raw JS
 * client never has to construct an Effect `Duration`.
 */
import { Effect } from "effect";
import type { AgenticConfig, AgenticEndpoint } from "./agentic.ts";
import type {
  ActivateRequest,
  ActivatedJob,
  EngineClient,
  JobRunner,
  Logger,
  ReconcileReader,
  ScanAgentLeaves,
} from "./ports.ts";
import { noopLogger, SupervisorError } from "./ports.ts";
import type { Registry } from "./registry.ts";
import type { SupervisorConfig, SupervisorDeps } from "./supervisor.ts";

/** Map a thrown/rejected value into the single tagged failure the ports expose. */
const toSupervisorError = (fallback: string) => (cause: unknown): SupervisorError =>
  cause instanceof SupervisorError
    ? cause
    : new SupervisorError(cause instanceof Error ? cause.message : fallback, cause);

/**
 * Plain, Effect-free engine surface the monolith implements against the C8 v2
 * REST API (`supervisor-engine.mjs`). `activate` is ONE long-poll for ONE type
 * (`POST /v2/jobs/activation`), resolving 0..`maxJobsToActivate` jobs; a rejected
 * promise (network/5xx) becomes a {@link SupervisorError} so the activation race
 * treats it as that poll losing, never a crash. `extendLock` SETs the job's lock
 * to `ms` from now (`PATCH /v2/jobs/{jobKey}/timeout`); a rejection on the
 * winner's first extend signals a likely reclaim race — {@link dispatch} then
 * declines to start the agent.
 */
export interface RawEngineClient {
  activate(req: ActivateRequest): Promise<ReadonlyArray<ActivatedJob>>;
  extendLock(jobKey: string, ms: number): Promise<void>;
}

/** Lift a plain {@link RawEngineClient} into the Effect {@link EngineClient} port. */
export const makeEngineClient = (raw: RawEngineClient): EngineClient => ({
  activate: (req) =>
    Effect.tryPromise({
      try: () => Promise.resolve(raw.activate(req)),
      catch: toSupervisorError(`activate ${req.type} failed`),
    }),
  extendLock: (jobKey, ms) =>
    Effect.tryPromise({
      try: () => Promise.resolve(raw.extendLock(jobKey, ms)).then(() => undefined),
      catch: toSupervisorError(`extendLock ${jobKey} failed`),
    }),
});

/**
 * Plain, Effect-free reconcile surface — exactly the shape the monolith's
 * `defaultC8RestReader` (a `@nanobpm/agentic` `httpC8RestReader`) already
 * returns: enumerate deployed process-definition keys, then fetch each one's
 * BPMN XML. The real adapter reuses a keep-alive pool + a once-resolved
 * (IPv4-first) engine host so the 1 + N crawl is paid at most once per new key.
 */
export interface RawReconcileReader {
  searchProcessDefinitionKeys(): Promise<ReadonlyArray<string>>;
  getProcessDefinitionXml(key: string): Promise<string>;
}

/** Lift a plain {@link RawReconcileReader} into the Effect {@link ReconcileReader} port. */
export const makeReconcileReader = (raw: RawReconcileReader): ReconcileReader => ({
  searchProcessDefinitionKeys: () =>
    Effect.tryPromise({
      try: () => Promise.resolve(raw.searchProcessDefinitionKeys()),
      catch: toSupervisorError("searchProcessDefinitionKeys failed"),
    }),
  getProcessDefinitionXml: (key) =>
    Effect.tryPromise({
      try: () => Promise.resolve(raw.getProcessDefinitionXml(key)),
      catch: toSupervisorError(`getProcessDefinitionXml ${key} failed`),
    }),
});

/**
 * Plain, Effect-free job runner — the monolith's `runAgentJob` harness, which
 * runs one activated job to completion (provision → execute → stream transcript
 * → complete/fail the job). The supervisor owns the lock lifecycle AROUND this
 * (short lock → extend-to-window → heartbeat), so the runner just executes; a
 * rejection is surfaced (and logged) by {@link dispatch}, never crashing the loop.
 */
export interface RawJobRunner {
  run(job: ActivatedJob): Promise<void>;
}

/** Lift a plain {@link RawJobRunner} into the Effect {@link JobRunner} port. */
export const makeJobRunner = (raw: RawJobRunner): JobRunner => ({
  run: (job) =>
    Effect.tryPromise({
      try: () => Promise.resolve(raw.run(job)).then(() => undefined),
      catch: toSupervisorError(`run ${job.jobKey} failed`),
    }),
});

/**
 * Coerce any `{ info, warn, debug? }`-shaped object (the plugin's `getLogger()`
 * or bare `console`) into the {@link Logger} port, guarding `debug` so an adapter
 * that omits it is a safe no-op rather than a crash. Returns {@link noopLogger}
 * when nothing usable is supplied.
 */
export const asLogger = (raw?: Partial<Logger> | null): Logger => {
  if (!raw || typeof raw.info !== "function" || typeof raw.warn !== "function") return noopLogger;
  const info = raw.info.bind(raw);
  const warn = raw.warn.bind(raw);
  const debug = typeof raw.debug === "function" ? raw.debug.bind(raw) : () => {};
  return { info, warn, debug };
};

/**
 * The full set of already-lifted ports + collaborators a JS caller assembles to
 * run {@link makeSupervisor}. `engine`/`runner`/`reconcileReader`/`logger` are
 * the {@link makeEngineClient}/{@link makeJobRunner}/{@link makeReconcileReader}/
 * {@link asLogger} outputs; `registry` is a `Ref`-backed handle the caller built
 * (and seeded with workers) via `makeRegistry`; `scan` is
 * `demand.scanTaskDefinitions` from the plugin's single agentic import surface.
 *
 * Derived from {@link SupervisorDeps} so the deps shape has a single source of
 * truth: adding a dep to `SupervisorDeps` automatically flows here rather than
 * silently drifting from a hand-maintained duplicate.
 */
export type SupervisorDepsInput = SupervisorDeps;

/**
 * Assemble a {@link SupervisorDeps} from already-lifted ports — the single typed
 * seam the monolith calls so the deps shape stays checked in one place (a JS
 * caller can't be type-checked against `makeSupervisor`'s parameter directly).
 * Pure: it neither opens sockets nor runs Effects; the caller runs
 * `makeSupervisor(makeSupervisorDeps(...))` under `Effect.runPromise` and forks
 * `supervisor.run`. `undefined` optionals are omitted so the supervisor's own
 * defaults apply and an absent `agenticEndpoint` cleanly degrades to the
 * connectionless loop.
 */
export const makeSupervisorDeps = (input: SupervisorDepsInput): SupervisorDepsInput => {
  const deps: { -readonly [K in keyof SupervisorDepsInput]: SupervisorDepsInput[K] } = {
    engine: input.engine,
    runner: input.runner,
    registry: input.registry,
    reconcileReader: input.reconcileReader,
    scan: input.scan,
    logger: asLogger(input.logger),
  };
  if (input.autoWorkerId !== undefined) deps.autoWorkerId = input.autoWorkerId;
  if (input.agenticEndpoint !== undefined) deps.agenticEndpoint = input.agenticEndpoint;
  if (input.agenticConfig !== undefined) deps.agenticConfig = input.agenticConfig;
  if (input.config !== undefined) deps.config = input.config;
  return deps;
};
