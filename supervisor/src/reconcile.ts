/**
 * Single, cheap, cached reconcile of deployed agent job types.
 *
 * Today every `--auto` worker independently re-reads the engine every 5s with a
 * **1 + N serial crawl** (`searchProcessDefinitionKeys()` then
 * `getProcessDefinitionXml(key)` per definition) through a **fresh, non-keep-alive
 * reader built every pass**. On the `merlin.local` path that compounded a ~5s
 * per-connection mDNS stall × 30 serial fetches into ~150s and blew the 15s
 * budget every pass.
 *
 * This reconcile runs **once per host** and:
 *   - caches XML by `processDefinitionKey` (deployed XML is immutable per key) and
 *     **only fetches XML for keys it has never seen**;
 *   - **short-circuits the XML crawl entirely** when the definition-key set is
 *     unchanged (it hashes the key list — an unchanged hash means zero fetches);
 *   - drops cache entries for keys that vanished from the engine.
 *
 * Keep-alive pooling and IPv4-first host resolution live in the injected
 * {@link ReconcileReader} adapter (dovetailing with #151); this module owns the
 * caching/short-circuit logic that removes the reason the crawl was expensive.
 */
import { Effect } from "effect";
import type { ReconcileReader, ScanAgentLeaves } from "./ports.ts";

export interface ReconcileCache {
  /** Order-insensitive fingerprint of the last-seen key set; "" before the first pass. */
  readonly keySetHash: string;
  /** Immutable XML keyed by processDefinitionKey. */
  readonly xmlByKey: ReadonlyMap<string, string>;
  /** The distinct agent job types, in first-occurrence order. */
  readonly jobTypes: ReadonlyArray<string>;
}

export const emptyCache: ReconcileCache = { keySetHash: "", xmlByKey: new Map(), jobTypes: [] };

export interface ReconcileResult {
  readonly cache: ReconcileCache;
  /** True when the key set changed and we (re)scanned; false == short-circuited. */
  readonly crawled: boolean;
  /** The keys whose XML we actually fetched this pass (new keys only). */
  readonly fetchedKeys: ReadonlyArray<string>;
}

/** Order-insensitive hash of a key list. Sorting makes reordering a non-change. */
export function hashKeys(keys: ReadonlyArray<string>): string {
  return [...keys].sort().join("\u0000");
}

function distinctJobTypes(
  keys: ReadonlyArray<string>,
  xmlByKey: ReadonlyMap<string, string>,
  scan: ScanAgentLeaves,
  scope: string,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    const xml = xmlByKey.get(key);
    if (xml === undefined) continue;
    for (const leaf of scan(xml)) {
      if (scope && !(leaf.process === scope || leaf.process.startsWith(scope))) continue;
      if (seen.has(leaf.taskType)) continue;
      seen.add(leaf.taskType);
      out.push(leaf.taskType);
    }
  }
  return out;
}

/**
 * Run one reconcile pass against `prev`. Fetches XML for **new keys only**, and
 * when the key set is unchanged returns `prev` untouched with `crawled:false`
 * (no `searchProcessDefinitionKeys` follow-up crawl at all).
 */
export const reconcile = (
  reader: ReconcileReader,
  scan: ScanAgentLeaves,
  prev: ReconcileCache,
  scope = "",
): Effect.Effect<ReconcileResult, import("./ports.ts").SupervisorError> =>
  Effect.gen(function* () {
    const keys = yield* reader.searchProcessDefinitionKeys();
    const hash = hashKeys(keys);
    if (hash === prev.keySetHash) {
      return { cache: prev, crawled: false, fetchedKeys: [] };
    }

    const present = new Set(keys);
    const nextXml = new Map<string, string>();
    // Keep cached XML for keys still present (immutable per key — never re-fetch).
    for (const [key, xml] of prev.xmlByKey) {
      if (present.has(key)) nextXml.set(key, xml);
    }
    const fetchedKeys: string[] = [];
    for (const key of keys) {
      if (nextXml.has(key)) continue;
      const xml = yield* reader.getProcessDefinitionXml(key);
      nextXml.set(key, xml);
      fetchedKeys.push(key);
    }

    const jobTypes = distinctJobTypes(keys, nextXml, scan, scope);
    return {
      cache: { keySetHash: hash, xmlByKey: nextXml, jobTypes },
      crawled: true,
      fetchedKeys,
    };
  });
