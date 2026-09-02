import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { emptyCache, hashKeys, reconcile } from "../src/reconcile.ts";
import { makeReader } from "./fakes.ts";

// A trivial scan: the "xml" IS the job type list, comma-separated, process "p".
const scan = (xml: string) =>
  xml
    .split(",")
    .filter(Boolean)
    .map((taskType) => ({ taskType, process: "p" }));

test("first pass fetches every key's XML and derives distinct job types", async () => {
  const reader = makeReader([["k1", "k2"]], { k1: "a,b", k2: "b,c" });
  const res = await Effect.runPromise(reconcile(reader, scan, emptyCache));
  assert.equal(res.crawled, true);
  assert.deepEqual([...res.fetchedKeys].sort(), ["k1", "k2"]);
  assert.deepEqual(res.cache.jobTypes, ["a", "b", "c"]); // first-occurrence order, deduped
});

test("unchanged key-set short-circuits: no XML crawl, zero fetches", async () => {
  const reader = makeReader([["k1", "k2"], ["k2", "k1"]], { k1: "a", k2: "b" });
  const first = await Effect.runPromise(reconcile(reader, scan, emptyCache));
  const before = reader.xmlFetches.length;
  // Second pass returns the same keys (reordered) → hash unchanged → skip crawl.
  const second = await Effect.runPromise(reconcile(reader, scan, first.cache));
  assert.equal(second.crawled, false);
  assert.deepEqual(second.fetchedKeys, []);
  assert.equal(reader.xmlFetches.length, before, "no additional getProcessDefinitionXml calls");
  assert.strictEqual(second.cache, first.cache, "cache is returned untouched");
});

test("only NEW keys are fetched when the set grows; cached XML is reused", async () => {
  const reader = makeReader([["k1"], ["k1", "k2"]], { k1: "a", k2: "b" });
  const first = await Effect.runPromise(reconcile(reader, scan, emptyCache));
  assert.deepEqual(first.fetchedKeys, ["k1"]);
  const second = await Effect.runPromise(reconcile(reader, scan, first.cache));
  assert.equal(second.crawled, true);
  assert.deepEqual(second.fetchedKeys, ["k2"], "k1 XML reused from cache, only k2 fetched");
  assert.deepEqual(second.cache.jobTypes, ["a", "b"]);
});

test("keys that vanish are dropped from the cache and from job types", async () => {
  const reader = makeReader([["k1", "k2"], ["k1"]], { k1: "a", k2: "b" });
  const first = await Effect.runPromise(reconcile(reader, scan, emptyCache));
  const second = await Effect.runPromise(reconcile(reader, scan, first.cache));
  assert.deepEqual([...second.cache.xmlByKey.keys()], ["k1"]);
  assert.deepEqual(second.cache.jobTypes, ["a"]);
});

test("hashKeys is order-insensitive", () => {
  assert.equal(hashKeys(["a", "b", "c"]), hashKeys(["c", "a", "b"]));
  assert.notEqual(hashKeys(["a", "b"]), hashKeys(["a", "b", "c"]));
});
