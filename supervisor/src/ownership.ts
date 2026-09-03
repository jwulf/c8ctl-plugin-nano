/**
 * The **claim registry** — the race-free source of truth for "who owns what job"
 * (issue #158).
 *
 * Today the cockpit's `jobKeys` are *inferred* from the terminal relay-transcript
 * correlation: a worker's live jobKeys are announced on `register` but discarded
 * at ingest, so visibility is reconstructed from a `job:<jobKey>` produce frame
 * keyed by `conn.id`. That inference is fragile in three independent ways (a
 * mid-job reconnect strands the jobKey, a silent agent that emits no post-open
 * frame never lands, and #154's single host connection breaks the 1-instance:
 * 1-connection assumption entirely), which is why a connected, actively-working
 * worker shows `jobKeys:[]`.
 *
 * This registry replaces that inference with an **explicit, event-driven,
 * idempotent** fact: `claim(instance, jobKey)` at dispatch, `release` on child
 * exit. It is keyed by explicit **instance**, never `conn.id`, so one host
 * connection can multiplex N workers. The claim's lifetime is bound to the agent
 * child process lifetime (see {@link withOwnedJob}), which is what makes a silent,
 * zero-transcript agent read as `claimed = working`, and lets a reconnect replay
 * the full active-claim set (`snapshot` → {@link resyncOwnership}).
 */
import { Effect, Ref } from "effect";
import type { AgenticCapability, AgenticHandle, SupervisedAgentic } from "./agentic.ts";
import type { Logger, SupervisorError } from "./ports.ts";
import { noopLogger } from "./ports.ts";

/** One registered worker and the set of jobs it currently owns. */
export interface OwnedWorker {
  readonly instance: string;
  readonly capability: AgenticCapability;
  readonly jobKeys: ReadonlyArray<string>;
}

interface WorkerEntry {
  readonly capability: AgenticCapability;
  readonly jobKeys: ReadonlySet<string>;
}

export interface OwnershipState {
  readonly workers: ReadonlyMap<string, WorkerEntry>;
}

export const emptyOwnership: OwnershipState = { workers: new Map() };

// ---- Pure, unit-testable transitions -------------------------------------------------

/** Record/refresh a worker's presence. Preserves any jobKeys already claimed. */
export function registerWorker(
  state: OwnershipState,
  instance: string,
  capability: AgenticCapability,
): OwnershipState {
  const workers = new Map(state.workers);
  const prev = workers.get(instance);
  workers.set(instance, { capability, jobKeys: prev?.jobKeys ?? new Set() });
  return { workers };
}

/** Drop a worker's presence entirely (its claims go with it). */
export function deregisterWorker(state: OwnershipState, instance: string): OwnershipState {
  if (!state.workers.has(instance)) return state;
  const workers = new Map(state.workers);
  workers.delete(instance);
  return { workers };
}

/**
 * Idempotently claim `jobKey` for `instance`. Auto-registers an as-yet-unseen
 * instance with an empty capability so a claim can never be lost to ordering.
 */
export function claimJob(state: OwnershipState, instance: string, jobKey: string): OwnershipState {
  const workers = new Map(state.workers);
  const prev = workers.get(instance);
  const jobKeys = new Set(prev?.jobKeys ?? []);
  jobKeys.add(jobKey);
  workers.set(instance, { capability: prev?.capability ?? {}, jobKeys });
  return { workers };
}

/** Idempotently release `jobKey` from `instance`. A late/duplicate release is a no-op. */
export function releaseJob(state: OwnershipState, instance: string, jobKey: string): OwnershipState {
  const prev = state.workers.get(instance);
  if (!prev || !prev.jobKeys.has(jobKey)) return state;
  const workers = new Map(state.workers);
  const jobKeys = new Set(prev.jobKeys);
  jobKeys.delete(jobKey);
  workers.set(instance, { capability: prev.capability, jobKeys });
  return { workers };
}

/** Every registered worker with its currently-owned jobKeys — the resync/cockpit source. */
export function snapshotOwnership(state: OwnershipState): ReadonlyArray<OwnedWorker> {
  const out: OwnedWorker[] = [];
  for (const [instance, entry] of state.workers) {
    out.push({ instance, capability: entry.capability, jobKeys: [...entry.jobKeys] });
  }
  return out;
}

/** The jobKeys one instance currently owns (empty if unknown). */
export function jobKeysForInstance(state: OwnershipState, instance: string): ReadonlyArray<string> {
  const entry = state.workers.get(instance);
  return entry ? [...entry.jobKeys] : [];
}

// ---- Ref-backed handle for the running supervisor ------------------------------------

/**
 * The live claim registry. Mutations are purely local `Ref` updates — the source
 * of truth — decoupled from the wire so a transport hiccup never corrupts
 * ownership; the frames it emits are best-effort mirrors (see {@link makeOwnershipContext}).
 */
export interface OwnershipRegistry {
  readonly get: Effect.Effect<OwnershipState>;
  register(instance: string, capability: AgenticCapability): Effect.Effect<void>;
  deregister(instance: string): Effect.Effect<void>;
  claim(instance: string, jobKey: string): Effect.Effect<void>;
  release(instance: string, jobKey: string): Effect.Effect<void>;
  readonly snapshot: Effect.Effect<ReadonlyArray<OwnedWorker>>;
  jobKeysFor(instance: string): Effect.Effect<ReadonlyArray<string>>;
}

export const makeOwnershipRegistry = (
  initial: OwnershipState = emptyOwnership,
): Effect.Effect<OwnershipRegistry> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(initial);
    return {
      get: Ref.get(ref),
      register: (instance, capability) => Ref.update(ref, (s) => registerWorker(s, instance, capability)),
      deregister: (instance) => Ref.update(ref, (s) => deregisterWorker(s, instance)),
      claim: (instance, jobKey) => Ref.update(ref, (s) => claimJob(s, instance, jobKey)),
      release: (instance, jobKey) => Ref.update(ref, (s) => releaseJob(s, instance, jobKey)),
      snapshot: Ref.get(ref).pipe(Effect.map(snapshotOwnership)),
      jobKeysFor: (instance) => Ref.get(ref).pipe(Effect.map((s) => jobKeysForInstance(s, instance))),
    };
  });

// ---- Frame emission (additive / version-negotiated, best-effort) ---------------------

/**
 * Run one optional ownership frame. The frame is `undefined` when the endpoint
 * predates #158 (additive negotiation), in which case emission is a no-op. A
 * transport error is logged and swallowed — the registry, not the wire, is the
 * source of truth, so a dropped frame delays visibility (the next resync replays
 * it) but never corrupts ownership or crashes the supervisor.
 */
export const emitFrame = (
  frame: Effect.Effect<void, SupervisorError> | undefined,
  logger: Logger,
  name: string,
): Effect.Effect<void> =>
  frame === undefined
    ? Effect.void
    : frame.pipe(
        Effect.catch((err: SupervisorError) =>
          Effect.sync(() => logger.debug?.(`agentic ${name} frame failed — ${err.message}`)),
        ),
      );

/**
 * Binds the ownership registry (source of truth) to a *swappable* transport (the
 * `currentHandle` that {@link superviseAgentic} reconnects underneath). Every
 * mutation updates the registry first, then mirrors it onto whatever handle is
 * live right now — so a reconnect never breaks claim emission.
 */
export interface OwnershipContext {
  readonly ownership: OwnershipRegistry;
  register(instance: string, capability: AgenticCapability): Effect.Effect<void>;
  claim(instance: string, jobKey: string): Effect.Effect<void>;
  transcript(instance: string, jobKey: string, chunk: Uint8Array): Effect.Effect<void>;
  release(instance: string, jobKey: string): Effect.Effect<void>;
}

export const makeOwnershipContext = (
  ownership: OwnershipRegistry,
  supervised: SupervisedAgentic,
  logger: Logger = noopLogger,
): OwnershipContext => {
  const onHandle = (
    f: (h: AgenticHandle) => Effect.Effect<void, SupervisorError> | undefined,
    name: string,
  ): Effect.Effect<void> =>
    supervised.currentHandle.pipe(
      Effect.flatMap((h) => (h ? emitFrame(f(h), logger, name) : Effect.void)),
    );
  return {
    ownership,
    register: (instance, capability) =>
      ownership.register(instance, capability).pipe(
        Effect.flatMap(() => onHandle((h) => h.register?.(instance, capability), "register")),
      ),
    claim: (instance, jobKey) =>
      ownership.claim(instance, jobKey).pipe(
        Effect.flatMap(() => onHandle((h) => h.claim?.(instance, jobKey), "claim")),
      ),
    transcript: (instance, jobKey, chunk) =>
      onHandle((h) => h.transcript?.(instance, jobKey, chunk), "transcript"),
    release: (instance, jobKey) =>
      ownership.release(instance, jobKey).pipe(
        Effect.flatMap(() => onHandle((h) => h.release?.(instance, jobKey), "release")),
      ),
  };
};

/**
 * Own `jobKey` for the lifetime of `use` (the agent child process).
 *
 * The claim is emitted **before** `use` starts (at dispatch/spawn) and the
 * release runs on **every** exit path — success, failure, AND interruption — via
 * `ensuring`, so the invariant **claim lifetime == agent child process lifetime**
 * holds even on an unclean kill (SIGTERM interrupts the fiber → release fires →
 * the jobKey clears within one window, no leak). Because release runs only
 * *after* `use` completes, it also honours **release-not-before-live**: transport
 * for a job is never torn down while its child can still produce.
 */
export const withOwnedJob = <A, E, R>(
  ctx: OwnershipContext,
  instance: string,
  jobKey: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  ctx.claim(instance, jobKey).pipe(
    Effect.flatMap(() => use),
    Effect.ensuring(ctx.release(instance, jobKey)),
  );

/**
 * The reconnect-resync hook. On every (re)connect the supervisor replays the full
 * active-claim set **before** resuming transcript: re-`register` each worker, then
 * re-`claim` each job it currently owns. Every frame is idempotent, so a resync is
 * safe whether the server already knows the claim or lost it on the dropped
 * socket. This is the replay the relay-open correlation could never do — it is why
 * a mid-job WS reconnect no longer blanks a still-running job's jobKey.
 */
export const resyncOwnership = (
  handle: AgenticHandle,
  ownership: OwnershipRegistry,
  logger: Logger = noopLogger,
): Effect.Effect<void> =>
  ownership.snapshot.pipe(
    Effect.flatMap((workers) =>
      Effect.forEach(
        workers,
        (w) =>
          emitFrame(handle.register?.(w.instance, w.capability), logger, "register").pipe(
            Effect.flatMap(() =>
              Effect.forEach(w.jobKeys, (jk) => emitFrame(handle.claim?.(w.instance, jk), logger, "claim"), {
                discard: true,
              }),
            ),
          ),
        { discard: true },
      ),
    ),
  );
