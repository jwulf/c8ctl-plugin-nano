/**
 * Dispatch + lock lifecycle for the winning job.
 *
 * The winner is activated with only a **short initial lock**. On dispatch we
 * immediately extend it **once** to the recovery window, and only then hand it to
 * the periodic extender + agent runner. The whole lifecycle is bracketed so the
 * worker slot and the heartbeat fiber are released on success, failure, AND
 * interruption.
 *
 * Invariants preserved here:
 *  (a) **extend the winner's lock *before* starting its agent** — if that first
 *      extend races a reclaim (the engine rejects it because another node already
 *      grabbed the job when the short lock lapsed), we DO NOT start: release the
 *      slot and bail. Starting an agent on a job we no longer own is the classic
 *      double-execution / stale 409 bug.
 *  (b) **never touch a parked/lapsed job again** — losers are dropped upstream in
 *      activation and never reach here, so a late complete/fail can't 409.
 */
import { Clock, Duration, Effect, Ref } from "effect";
import type { ActivatedJob, EngineClient, JobRunner, Logger } from "./ports.ts";
import { SupervisorError } from "./ports.ts";
import type { Registry } from "./registry.ts";
import type { OwnershipContext } from "./ownership.ts";
import { withOwnedJob } from "./ownership.ts";

/**
 * Does this extend/settle rejection mean the worker has DEFINITIVELY lost the job
 * (the lock lapsed and the broker reclaimed it, or the lease was superseded)? Only
 * these unambiguous ownership-loss signals — a 409 (reclaim / `JobLeaseMismatch`),
 * a 404 (job gone), or the engine's "not activated" body — mean the lease is gone.
 * Everything TRANSIENT (a 5xx, a 429, a network blip, a timeout) is NOT ownership
 * loss and must not, on its own, stop lock renewal.
 *
 * An explicit HTTP status is AUTHORITATIVE: when one can be determined (from the
 * message or the cause chain), only a definitive 409/404 means lost — a transient
 * status (503/429/…) is NOT ownership loss even if its body happens to carry a
 * textual lease-loss signal (e.g. a 503 "upstream not found"). The textual signals
 * are the fallback for when NO status is available.
 */
export const isLeaseLostError = (err: SupervisorError): boolean => {
  const status = statusFromMessage(err.message) ?? httpStatusOf(err.cause);
  if (status !== undefined) return isLostStatus(status);
  return LEASE_LOST_RE.test(err.message);
};

/**
 * Match the textual lease-loss signals. Beyond the raw client's own `HTTP 409`/
 * `HTTP 404` prefixes, an injected SDK rejection is often shaped like
 * `Request failed with status code 409`, so recognise `status code 409/404` too.
 */
const LEASE_LOST_RE =
  /HTTP 4(?:09|04)\b|status\s*code\s*4(?:09|04)\b|\bnot activated\b|joblease\s*mismatch|lease\s*mismatch|\bnot found\b|\breclaim/i;

/**
 * Issue #320: the one-line reason written to the agent-visible fence file when a
 * renewal error ends the heartbeat: `lease-lost: <status>` for a definitive loss
 * (`job-gone` for a 404), `lease-lost: unrenewable` for a permanent 4xx.
 */
export const leaseLostReason = (err: SupervisorError): string => {
  if (!isLeaseLostError(err)) return "lease-lost: unrenewable";
  const status = statusFromMessage(err.message) ?? httpStatusOf(err.cause);
  if (status === 404) return "job-gone";
  return `lease-lost: ${status ?? "not-activated"}`;
};

const isLostStatus = (status: number | undefined): boolean => status === 409 || status === 404;

/**
 * Pull an explicit HTTP status out of an error MESSAGE — the raw client's own
 * `HTTP 409`/`HTTP 404` prefixes and an injected SDK rejection's generic
 * `Request failed with status code 409` shape. Returns undefined when the message
 * carries no status (a bare "not activated" / "lease mismatch" body).
 */
const statusFromMessage = (message: string): number | undefined => {
  const m = /(?:HTTP|status\s*code)\s*(\d{3})\b/i.exec(message);
  return m ? Number(m[1]) : undefined;
};

/**
 * Pull an HTTP status off an arbitrary (SDK/fetch) error, walking its `cause`
 * chain: SDK rejections frequently expose the status NUMERICALLY (`err.status`,
 * `err.statusCode`, `err.response.status`) rather than only in the message, and
 * `toSupervisorError` preserves the original error on `.cause`. Bounded depth so
 * a cyclic cause can't loop.
 */
const httpStatusOf = (err: unknown, depth = 0): number | undefined => {
  if (!err || typeof err !== "object" || depth > 4) return undefined;
  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    cause?: unknown;
  };
  const s = e.status ?? e.statusCode ?? e.response?.status;
  if (typeof s === "number") return s;
  return httpStatusOf(e.cause, depth + 1);
};

/**
 * Does this extend rejection mean renewal can NEVER succeed by retrying — a
 * permanent client-side failure (a 400 bad-request / validation, or a 401/403
 * auth failure)? These are not transient: retrying them forever while the agent
 * keeps running would let the finite recovery window lapse with no successful
 * beat, so the broker reclaims and RE-RUNS the job — the exact duplicate-execution
 * this heartbeat exists to prevent. A 429 (rate-limited) and any 5xx are TRANSIENT
 * (the server is asking us to back off / is briefly unhealthy), so they are
 * excluded — only a definitively permanent 4xx counts.
 */
export const isPermanentRenewalError = (err: SupervisorError): boolean =>
  /HTTP 4(?:00|01|03|22)\b|\bunauthori[sz]ed\b|\bforbidden\b/i.test(err.message);

/**
 * A heartbeat beat must END the renewal loop (and so interrupt the run) when the
 * lock can no longer be held: either the lease is already lost
 * ({@link isLeaseLostError}) OR renewal is permanently impossible
 * ({@link isPermanentRenewalError}). Continuing the agent past either is pointless
 * and dangerous — the lock will lapse and the job will be redelivered.
 */
export const isTerminalRenewalError = (err: SupervisorError): boolean =>
  isLeaseLostError(err) || isPermanentRenewalError(err);

const defectText = (defect: unknown): string =>
  defect instanceof Error ? defect.message : String(defect);

// Issue #320: out-of-band renewals (a `fence-check`'s lease-fenced extendLock)
// recorded per activation (jobKey + leaseToken), so the heartbeat's lapse check
// counts a renewal it did not perform itself — otherwise a confirmed fence-check
// renewal could still be followed by a false `lease-lost: lapsed`. Timestamps
// come from the Effect `Clock` (wall time in production, TestClock in tests).
const externalRenewals = new Map<string, number>();
const renewalKey = (jobKey: string, leaseToken?: string): string => `${jobKey}\u0000${leaseToken ?? ""}`;
export const recordExternalRenewal = (jobKey: string, leaseToken?: string): Effect.Effect<void> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => Effect.sync(() => {
      const k = renewalKey(jobKey, leaseToken);
      // Only for an activation that is currently being dispatched (no unbounded growth).
      if (externalRenewals.has(k)) externalRenewals.set(k, Math.max(now, externalRenewals.get(k) ?? 0));
    })),
  );

export interface DispatchConfig {
  /** The window the winner's lock is held to and heartbeated at (ms). */
  readonly recoveryWindowMs: number;
  /** How often to re-extend the winner's lock while it runs (ms). */
  readonly extendIntervalMs: number;
  /**
   * Max time to AWAIT a single lock extend before abandoning it as a (transient)
   * renewal failure (ms). Defaults to {@link DispatchConfig.extendIntervalMs}. A
   * hung/slow extend — e.g. the SDK `updateJob` awaiting a wedged connection with
   * no timeout of its own — must NOT silently stall the heartbeat: without this
   * bound the beat would block inside the extend forever, `sinceOk` would never
   * advance, and the lapse guard could never fire, so the broker could reclaim the
   * job while the agent runs on. Bounding each extend turns a stall into a normal
   * failed beat that counts toward the recovery window.
   */
  readonly extendTimeoutMs?: number;
}

export const defaultDispatchConfig: DispatchConfig = {
  recoveryWindowMs: 300_000,
  extendIntervalMs: 60_000,
};

export interface DispatchDeps {
  readonly engine: EngineClient;
  readonly runner: JobRunner;
  readonly registry: Registry;
  readonly logger: Logger;
  readonly config: DispatchConfig;
  /**
   * When set, the job is `claim`ed on this ownership context for the lifetime of
   * the agent child (issue #158): the claim is emitted just before the runner
   * spawns the child and released on every exit path. The `workerId` is the
   * explicit `instance` on every ownership frame.
   */
  readonly ownership?: OwnershipContext;
}

export interface DispatchOutcome {
  readonly started: boolean;
  readonly reason?: "extend-failed" | "lock-lost";
}

/**
 * Dispatch `job` to already-claimed `workerId`. The slot MUST have been claimed
 * (`registry.claim`) before calling — this owns releasing it again.
 */
export const dispatch = (
  deps: DispatchDeps,
  job: ActivatedJob,
  workerId: string,
): Effect.Effect<DispatchOutcome, never> =>
  Effect.gen(function* () {
    const { engine, runner, registry, logger, config, ownership } = deps;
    // Issue #320: tell the runner the lease is gone BEFORE the race interrupts the
    // run, so the agent-visible fence file exists by the time the agent is killed.
    const notifyLeaseLost = (reason: string) =>
      Effect.sync(() => {
        try {
          runner.onLeaseLost?.(job, reason);
        } catch {
          /* best effort — a fence write must never break the heartbeat */
        }
      });
    // A single extend must never AWAIT unboundedly — a hung SDK/HTTP call would
    // otherwise stall both the winner extend (wedging the claimed slot forever) and
    // each heartbeat beat (freezing renewal). Bound every extend by this deadline.
    const extendTimeoutMs = Math.max(1, config.extendTimeoutMs ?? config.extendIntervalMs);

    // (a) Extend the winner FIRST. A failure (or a blown deadline) here means the
    // short lock likely lapsed and the job was reclaimed — or the extend path is
    // wedged — so do not start; give the slot straight back rather than block the
    // worker indefinitely on a hung call.
    const extended = yield* engine
      .extendLock(job.jobKey, config.recoveryWindowMs, job.leaseToken)
      .pipe(
        Effect.timeout(Duration.millis(extendTimeoutMs)),
        Effect.as(true),
        Effect.catch((err: { message?: string }) => {
          logger.warn(
            `[${job.type}] job ${job.jobKey}: winner extend failed (${err?.message ?? String(err)}) — not starting; slot released`,
          );
          return Effect.succeed(false);
        }),
      );

    if (!extended) {
      yield* registry.releaseWorker(workerId);
      return { started: false, reason: "extend-failed" };
    }

    // (b) Heartbeat + run. The heartbeat holds the lock for the agent's whole
    // run; the run and the heartbeat RACE so that either terminates the other:
    //   * agent finishes first → the heartbeat is interrupted (loser of the race);
    //   * the lease is definitively lost first → the heartbeat ends the race and
    //     the still-running agent is interrupted — a SUPERSEDED worker must stop,
    //     never run on to a doomed completeJob (which is what left empty transcript
    //     husks and let the broker redeliver the job in a loop).
    // The slot is released on every exit path.
    const lostLock = yield* Effect.gen(function* () {
      // One heartbeat beat: wait an interval, then SET the lock to the recovery
      // window (lease-fenced with `job.leaseToken`). Resilience is the whole point
      // here — this fiber must NOT die silently and stop renewing, but it must also
      // NOT keep an agent alive past its lock:
      //   * a TERMINAL renewal error (`isTerminalRenewalError`: a definitive
      //     lease-loss OR a permanent 400/401/403 that retrying can never fix) is
      //     re-raised IMMEDIATELY, ending the `forever` loop so the race interrupts
      //     the run;
      //   * a SPORADIC failure — a transient typed error (5xx / 429 / network blip),
      //     a HUNG extend that blew its deadline (a wedged SDK/HTTP call), or a
      //     DEFECT (e.g. the deployed `Not a valid effect: [object Promise]`, which
      //     a typed-only `Effect.catch` would let escape and KILL the fiber) — is
      //     logged and retried, BUT bounded: we compare NOW against the timestamp of
      //     the last SUCCESSFUL extend and, once the gap reaches the recovery window,
      //     the lock has lapsed (the broker will reclaim and re-run the job) so we
      //     stop retrying and interrupt the agent. A persistent outage is therefore
      //     treated as a lease loss the moment the lock can no longer be guaranteed
      //     — a sporadic blip still just retries.
      // Elapsed-since-success is read from the Effect `Clock` (NOT a fixed per-beat
      // increment), so it stays honest even when a beat is delayed by a hung extend
      // burning its whole `extendTimeoutMs` before failing. Under the deterministic
      // TestClock the clock advances exactly with `TestClock.adjust`, so this is
      // still fully deterministic.
      const lastOkAtRef = yield* Ref.make(yield* Clock.currentTimeMillis);
      const extKey = renewalKey(job.jobKey, job.leaseToken);
      const retryUnlessLapsed = (reason: string) =>
        Effect.all([Clock.currentTimeMillis, Ref.get(lastOkAtRef)]).pipe(
          Effect.flatMap(([now, ownOkAt]) => {
            const lastOkAt = Math.max(ownOkAt, externalRenewals.get(extKey) ?? 0);
            const sinceOk = now - lastOkAt;
            // If the NEXT beat would land at/after the window, the lock is (about
            // to be) lapsed — give up now, a beat BEFORE expiry, rather than run
            // the agent on unlocked.
            return sinceOk + config.extendIntervalMs >= config.recoveryWindowMs
              ? notifyLeaseLost("lease-lost: lapsed").pipe(Effect.andThen(Effect.fail(
                  new SupervisorError(
                    `job ${job.jobKey}: lock lapsed — no successful extend in ${sinceOk}ms (recovery window ${config.recoveryWindowMs}ms); last error: ${reason}`,
                  ),
                )))
              : Effect.sync(() =>
                  logger.warn(
                    `[${job.type}] job ${job.jobKey}: heartbeat extend failed (transient, retrying) — ${reason}`,
                  ),
                );
          }),
        );
      const beatOnce = Effect.sleep(Duration.millis(config.extendIntervalMs)).pipe(
        Effect.flatMap(() =>
          engine.extendLock(job.jobKey, config.recoveryWindowMs, job.leaseToken).pipe(
            // Bound each extend: a hung call is interrupted at its deadline and
            // surfaces a `TimeoutException` on the error channel, which the
            // `Effect.catch` below routes through `retryUnlessLapsed` — so a stall
            // burns toward the recovery window instead of freezing the heartbeat.
            Effect.timeout(Duration.millis(extendTimeoutMs)),
            Effect.flatMap(() => Clock.currentTimeMillis),
            Effect.flatMap((now) => Ref.set(lastOkAtRef, now)),
            Effect.catch((err: SupervisorError | { message?: string }) =>
              err instanceof SupervisorError && isTerminalRenewalError(err)
                ? notifyLeaseLost(leaseLostReason(err)).pipe(Effect.andThen(Effect.fail(err)))
                : retryUnlessLapsed(err?.message ?? String(err)),
            ),
            Effect.catchDefect((defect) => retryUnlessLapsed(defectText(defect))),
          ),
        ),
      );
      const heartbeatUntilLost = Effect.acquireUseRelease(
        Effect.sync(() => { externalRenewals.set(extKey, 0); }),
        () => Effect.forever(beatOnce),
        () => Effect.sync(() => { externalRenewals.delete(extKey); }),
      );

      // The agent child runs under a claim whose lifetime == the child's own
      // (issue #158): claimed just before spawn, released on every exit path so a
      // silent, zero-transcript agent still reads as `claimed = working` and an
      // unclean kill clears the jobKey within one window (no leak).
      const runChild = runner.run(job).pipe(
        Effect.catch((err: SupervisorError) =>
          Effect.sync(() => logger.warn(`[${job.type}] job ${job.jobKey}: run failed — ${err.message}`)),
        ),
      );
      const owned = ownership ? withOwnedJob(ownership, workerId, job.jobKey, runChild) : runChild;

      // `raceFirst`: the FIRST side to complete (success OR failure) wins and the
      // loser is interrupted. If a beat hits a TERMINAL renewal error it fails →
      // wins the race → `owned` (the agent) is interrupted; otherwise the agent
      // finishes and the heartbeat is interrupted. The failure is caught here → the
      // run stopped because the lock can no longer be held (superseded, or renewal
      // permanently impossible).
      return yield* Effect.raceFirst(owned, heartbeatUntilLost).pipe(
        Effect.as(false),
        Effect.catch((err: SupervisorError) =>
          Effect.sync(() => {
            logger.warn(
              `[${job.type}] job ${job.jobKey}: lock lost mid-run — agent interrupted (lock unrenewable); slot released — ${err.message}`,
            );
            return true;
          }),
        ),
      );
    }).pipe(Effect.ensuring(registry.releaseWorker(workerId)));

    return lostLock ? { started: true, reason: "lock-lost" } : { started: true };
  });
