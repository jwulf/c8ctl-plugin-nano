/**
 * In-memory fakes + helpers for driving the supervisor under Effect's TestClock.
 * Every port is faked so tests are deterministic (no engine, no sockets, no time).
 */
import { Duration, Effect } from "effect";
import type {
  ActivateRequest,
  ActivatedJob,
  EngineClient,
  JobRunner,
  ReconcileReader,
  SupervisorError as SupervisorErrorType,
} from "../src/ports.ts";
import { SupervisorError } from "../src/ports.ts";

export const job = (jobKey: string, type: string): ActivatedJob => ({ jobKey, type });

export interface EngineFake extends EngineClient {
  readonly leased: string[];
  readonly extended: Array<{ jobKey: string; ms: number }>;
  readonly activateCalls: string[];
}

export interface EngineOptions {
  /** Per-type activation behaviour. Return the jobs (may sleep to model a long-poll). */
  activate: (req: ActivateRequest) => Effect.Effect<ReadonlyArray<ActivatedJob>, SupervisorErrorType>;
  /** Optional extendLock override (e.g. to fail the winner extend). */
  extend?: (jobKey: string, ms: number) => Effect.Effect<void, SupervisorErrorType>;
}

export const makeEngine = (opts: EngineOptions): EngineFake => {
  const leased: string[] = [];
  const extended: Array<{ jobKey: string; ms: number }> = [];
  const activateCalls: string[] = [];
  return {
    leased,
    extended,
    activateCalls,
    activate: (req) =>
      Effect.sync(() => activateCalls.push(req.type)).pipe(
        Effect.flatMap(() => opts.activate(req)),
        Effect.tap((jobs) => Effect.sync(() => jobs.forEach((j) => leased.push(j.jobKey)))),
      ),
    extendLock: (jobKey, ms) =>
      opts.extend
        ? opts.extend(jobKey, ms).pipe(Effect.tap(() => Effect.sync(() => extended.push({ jobKey, ms }))))
        : Effect.sync(() => {
            extended.push({ jobKey, ms });
          }),
  };
};

/** An activation that returns `jobs` after `delayMs`, then blocks forever (idle long-poll). */
export const activateAfter =
  (map: Record<string, { job: ActivatedJob; delayMs: number }>) =>
  (req: ActivateRequest): Effect.Effect<ReadonlyArray<ActivatedJob>, SupervisorErrorType> => {
    const entry = map[req.type];
    if (!entry) return Effect.never as never;
    return Effect.sleep(Duration.millis(entry.delayMs)).pipe(Effect.as([entry.job]));
  };

export interface RunnerFake extends JobRunner {
  readonly ran: string[];
}

/** A runner that records the jobs it ran and blocks each for `runMs` (default 0). */
export const makeRunner = (runMs = 0): RunnerFake => {
  const ran: string[] = [];
  return {
    ran,
    run: (j) =>
      Effect.sync(() => ran.push(j.jobKey)).pipe(
        Effect.flatMap(() => (runMs > 0 ? Effect.sleep(Duration.millis(runMs)) : Effect.void)),
      ),
  };
};

export const makeReader = (
  keysSeq: ReadonlyArray<ReadonlyArray<string>>,
  xml: Record<string, string>,
): ReconcileReader & { readonly xmlFetches: string[]; readonly keyCalls: number } => {
  let call = 0;
  const xmlFetches: string[] = [];
  const state = {
    xmlFetches,
    get keyCalls() {
      return call;
    },
    searchProcessDefinitionKeys: () =>
      Effect.sync(() => {
        const keys = keysSeq[Math.min(call, keysSeq.length - 1)] ?? [];
        call += 1;
        return keys;
      }),
    getProcessDefinitionXml: (key: string) =>
      Effect.sync(() => {
        xmlFetches.push(key);
        return xml[key] ?? "";
      }),
  };
  return state as ReconcileReader & { readonly xmlFetches: string[]; readonly keyCalls: number };
};

export const failing = (message: string): Effect.Effect<never, SupervisorErrorType> =>
  Effect.fail(new SupervisorError(message));
