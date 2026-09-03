/**
 * Worker registry & capability map.
 *
 * Replaces today's design where each `nano work` process is a full, independent
 * supervisor with its own process-wide capacity-1 `singleFlight`. A single
 * per-host registry keeps a **capability map — job type → set of workers that can
 * service it** — and computes "free slots" **per job type**, never as one global
 * count. Because it lives in one event loop, slot accounting is race-free across
 * what used to be K separate `--name` processes.
 *
 * The state is a plain immutable-ish record with pure transition functions
 * (trivially unit-testable); {@link makeRegistry} wraps it in a `Ref` for the
 * runtime. `--auto` workers get their type set rewritten by the reconcile loop
 * via {@link setWorkerTypes}; heterogeneous profiles register explicit types.
 */
import { Effect, Ref } from "effect";

export interface WorkerState {
  readonly id: string;
  /** Job types this worker can service (explicit profile types, or auto-derived). */
  readonly types: ReadonlySet<string>;
  /** How many jobs this worker may run at once. 1 for agent workers (PTY + workspace). */
  readonly capacity: number;
  /** How many jobs it is running right now. */
  readonly active: number;
}

export interface RegistryState {
  readonly workers: ReadonlyMap<string, WorkerState>;
}

export const emptyRegistry: RegistryState = { workers: new Map() };

export function addWorker(
  state: RegistryState,
  id: string,
  types: Iterable<string>,
  capacity = 1,
): RegistryState {
  const workers = new Map(state.workers);
  const prev = workers.get(id);
  workers.set(id, {
    id,
    types: new Set(types),
    capacity,
    active: prev?.active ?? 0,
  });
  return { workers };
}

export function removeWorker(state: RegistryState, id: string): RegistryState {
  if (!state.workers.has(id)) return state;
  const workers = new Map(state.workers);
  workers.delete(id);
  return { workers };
}

/** Rewrite an existing worker's serviceable type set (the `--auto` reconcile path). */
export function setWorkerTypes(state: RegistryState, id: string, types: Iterable<string>): RegistryState {
  const prev = state.workers.get(id);
  if (!prev) return state;
  const workers = new Map(state.workers);
  workers.set(id, { ...prev, types: new Set(types) });
  return { workers };
}

/** Mark one unit of the worker busy. Throws past capacity — the caller must gate first. */
export function acquire(state: RegistryState, id: string): RegistryState {
  const prev = state.workers.get(id);
  if (!prev) throw new Error(`acquire: unknown worker ${id}`);
  if (prev.active >= prev.capacity) throw new Error(`acquire: worker ${id} at capacity`);
  const workers = new Map(state.workers);
  workers.set(id, { ...prev, active: prev.active + 1 });
  return { workers };
}

/** Release one unit. Clamped at 0 so a double-release is a safe no-op. */
export function release(state: RegistryState, id: string): RegistryState {
  const prev = state.workers.get(id);
  if (!prev) return state;
  const workers = new Map(state.workers);
  workers.set(id, { ...prev, active: Math.max(0, prev.active - 1) });
  return { workers };
}

/** Free slots for one job type = idle capacity summed over workers that service it. */
export function freeSlotsFor(state: RegistryState, type: string): number {
  let free = 0;
  for (const w of state.workers.values()) {
    if (w.types.has(type)) free += Math.max(0, w.capacity - w.active);
  }
  return free;
}

/** Every job type any registered worker can service (the reconcile-poll universe). */
export function serviceableTypes(state: RegistryState): ReadonlySet<string> {
  const out = new Set<string>();
  for (const w of state.workers.values()) for (const t of w.types) out.add(t);
  return out;
}

/**
 * The types we should actually hold an activation long-poll for **right now**:
 * serviceable AND with a free slot at request time. A type whose workers are all
 * busy is omitted → it generates zero activation traffic. This backpressure —
 * not one mega-poll — is where the polling storm collapses.
 */
export function typesWithCapacity(state: RegistryState): ReadonlyArray<string> {
  const out: string[] = [];
  for (const t of serviceableTypes(state)) {
    if (freeSlotsFor(state, t) > 0) out.push(t);
  }
  return out;
}

/**
 * Like {@link typesWithCapacity}, but pairs each serviceable-with-capacity type
 * with its current free-slot count — the per-type batch size a single activation
 * round may pull (capacity-sized batched activation).
 */
export function typesWithSlots(state: RegistryState): ReadonlyArray<{ type: string; freeSlots: number }> {
  const out: Array<{ type: string; freeSlots: number }> = [];
  for (const t of serviceableTypes(state)) {
    const free = freeSlotsFor(state, t);
    if (free > 0) out.push({ type: t, freeSlots: free });
  }
  return out;
}

/** Pick an idle worker able to service `type`, or `null` if none is free. */
export function pickWorkerFor(state: RegistryState, type: string): string | null {
  for (const w of state.workers.values()) {
    if (w.types.has(type) && w.active < w.capacity) return w.id;
  }
  return null;
}

/** A `Ref`-backed registry handle for the running supervisor. */
export interface Registry {
  readonly get: Effect.Effect<RegistryState>;
  add(id: string, types: Iterable<string>, capacity?: number): Effect.Effect<void>;
  remove(id: string): Effect.Effect<void>;
  setTypes(id: string, types: Iterable<string>): Effect.Effect<void>;
  /** Atomically claim an idle worker for `type`; resolves the worker id or `null` if none free. */
  claim(type: string): Effect.Effect<string | null>;
  releaseWorker(id: string): Effect.Effect<void>;
  readonly pollTypes: Effect.Effect<ReadonlyArray<string>>;
  /**
   * The serviceable-with-capacity types paired with their free-slot count — the
   * per-type batch size for capacity-sized batched activation.
   */
  readonly pollBatch: Effect.Effect<ReadonlyArray<{ type: string; freeSlots: number }>>;
}

export const makeRegistry = (initial: RegistryState = emptyRegistry): Effect.Effect<Registry> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(initial);
    const registry: Registry = {
      get: Ref.get(ref),
      add: (id, types, capacity = 1) => Ref.update(ref, (s) => addWorker(s, id, types, capacity)),
      remove: (id) => Ref.update(ref, (s) => removeWorker(s, id)),
      setTypes: (id, types) => Ref.update(ref, (s) => setWorkerTypes(s, id, types)),
      claim: (type) =>
        Ref.modify(ref, (s) => {
          const id = pickWorkerFor(s, type);
          if (id === null) return [null, s];
          return [id, acquire(s, id)];
        }),
      releaseWorker: (id) => Ref.update(ref, (s) => release(s, id)),
      pollTypes: Ref.get(ref).pipe(Effect.map(typesWithCapacity)),
      pollBatch: Ref.get(ref).pipe(Effect.map(typesWithSlots)),
    };
    return registry;
  });
