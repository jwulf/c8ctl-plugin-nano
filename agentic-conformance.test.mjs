// Shared conformance corpus for the Nano agentic protocol (ADR 0056).
//
// This wires `@nanobpm/agentic/protocol/conformance` — the SAME golden frames,
// malformed vectors, routing-token vectors and vocab documents the hub
// (nano-workforce#142) and the worker client are held to — into this repo's
// `node --test` suite. It is the single source of truth that keeps this repo's
// consumption of the wire contract from drifting from the hub: a vector that
// looks wrong is fixed upstream in the corpus, never worked around here.
//
// We hold the codec / grammar / schema re-exported through this plugin's single
// agentic import surface (`./agentic.mjs`) to the corpus, so the surface the
// sibling slices build on is the exact one under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GOLDEN_FRAMES,
  MALFORMED_FRAMES,
  VALID_TOKENS,
  INVALID_TOKENS,
  VALID_VOCABS,
  INVALID_VOCABS,
} from '@nanobpm/agentic/protocol/conformance';

import {
  encodeFrame,
  decodeFrame,
  FrameDecodeError,
  bytesToHex,
  hexToBytes,
  parseToken,
  TokenParseError,
  validateVocabDocument,
} from './agentic.mjs';

// Guard: an empty corpus would make every loop below vacuously pass, hiding a
// broken import. Assert we actually loaded vectors of every family.
test('conformance corpus is non-empty for every family', () => {
  assert.ok(GOLDEN_FRAMES.length > 0, 'expected golden frames');
  assert.ok(MALFORMED_FRAMES.length > 0, 'expected malformed frames');
  assert.ok(VALID_TOKENS.length > 0, 'expected valid tokens');
  assert.ok(INVALID_TOKENS.length > 0, 'expected invalid tokens');
  assert.ok(VALID_VOCABS.length > 0, 'expected valid vocabs');
  assert.ok(INVALID_VOCABS.length > 0, 'expected invalid vocabs');
});

test('golden frames round-trip through the codec in both directions', async (t) => {
  for (const golden of GOLDEN_FRAMES) {
    await t.test(`${golden.direction}: ${golden.name}`, () => {
      // frame -> bytes must reproduce the committed wire encoding exactly.
      const encoded = encodeFrame(golden.frame);
      assert.equal(
        bytesToHex(encoded),
        golden.hex,
        'encoded wire bytes drifted from the golden',
      );

      // bytes -> frame must reproduce the golden frame exactly.
      const decoded = decodeFrame(hexToBytes(golden.hex));
      assert.deepEqual(decoded, golden.frame, 'decoded frame drifted from the golden');
    });
  }
});

test('malformed frames are rejected with the exact decode error code', async (t) => {
  for (const bad of MALFORMED_FRAMES) {
    await t.test(bad.name, () => {
      assert.throws(
        () => decodeFrame(hexToBytes(bad.hex)),
        (err) => {
          assert.ok(err instanceof FrameDecodeError, `expected FrameDecodeError, got ${err}`);
          assert.equal(err.code, bad.expected, 'decode error code mismatch');
          return true;
        },
      );
    });
  }
});

test('valid routing tokens parse to the expected decomposition', async (t) => {
  for (const vec of VALID_TOKENS) {
    await t.test(vec.name, () => {
      assert.deepEqual(parseToken(vec.token), vec.parsed);
    });
  }
});

test('invalid routing tokens are rejected with the exact parse error code', async (t) => {
  for (const vec of INVALID_TOKENS) {
    await t.test(vec.name, () => {
      assert.throws(
        () => parseToken(vec.token),
        (err) => {
          assert.ok(err instanceof TokenParseError, `expected TokenParseError, got ${err}`);
          assert.equal(err.code, vec.expected, 'token parse error code mismatch');
          return true;
        },
      );
    });
  }
});

test('valid vocab documents pass schema validation', async (t) => {
  for (const vec of VALID_VOCABS) {
    await t.test(vec.name, () => {
      const result = validateVocabDocument(vec.document);
      assert.ok(result.ok, `expected valid vocab, got errors: ${JSON.stringify(result.errors)}`);
    });
  }
});

test('invalid vocab documents surface the expected validation code', async (t) => {
  for (const vec of INVALID_VOCABS) {
    await t.test(vec.name, () => {
      const result = validateVocabDocument(vec.document);
      assert.equal(result.ok, false, 'expected invalid vocab to be rejected');
      if (result.ok === false) {
        const codes = result.errors.map((e) => e.code);
        assert.ok(
          codes.includes(vec.expectedCode),
          `expected error code ${vec.expectedCode} among ${JSON.stringify(codes)}`,
        );
      }
    });
  }
});
