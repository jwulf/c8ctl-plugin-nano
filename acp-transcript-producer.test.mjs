// Producer-side ACP message-boundary preservation (jwulf/c8ctl-plugin-nano#206).
//
// These tests prove the PRODUCER carries the available ACP message identity / role
// / delta semantics into the shared additive `MessageEvent` contract from
// nanobpm/nano-ide#566, and that the resulting canonical chunk bytes — when folded
// through the REAL shared ordered-display derivation (`deriveDisplay`) — reconstruct
// transport-fragmented deltas into coherent blocks, keep distinct same-speaker
// messages apart, and interleave tool/permission events in chronological order.
//
// The fixtures are representative ACP `session/update` shapes for the supported
// worker families (opencode / claude-code-acp / the Gemini lineage all speak the
// same normalised ACP wire). The chunk bytes are produced by the real
// `acpUpdateToDisplayChunk`, parsed by the real `parseTranscriptEvent`, and folded
// by the real `deriveDisplay` — never a hand-rolled envelope or a mock of a guessed
// API.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { acpUpdateToDisplayChunk } from './acp-transcript-producer.mjs';
// The SAME shared transcript seams the cockpit / nano-workforce consumer use — the
// canonical encoder is exercised inside the producer, and the parser + ordered
// display fold are exercised here, all through the single agentic import surface.
import { transcript, sessionAcp } from './agentic.mjs';

const { parseTranscriptEvent, deriveDisplay } = transcript;

// ---------------------------------------------------------------------------
// Fixture builders — representative ACP `session/update` `update` objects.
// ---------------------------------------------------------------------------
function assistantChunk(text, messageId) {
  const u = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
  if (messageId !== undefined) u.messageId = messageId;
  return u;
}
function thoughtChunk(text, messageId) {
  const u = { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } };
  if (messageId !== undefined) u.messageId = messageId;
  return u;
}
function userChunk(text, messageId) {
  const u = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } };
  if (messageId !== undefined) u.messageId = messageId;
  return u;
}
function toolCall(toolCallId, title, rawInput) {
  return { sessionUpdate: 'tool_call', toolCallId, title, rawInput };
}
function toolResult(toolCallId, status, rawOutput) {
  return { sessionUpdate: 'tool_call_update', toolCallId, status, rawOutput };
}

// Run a sequence of ACP updates through the producer, assign monotonic store
// offsets to the non-null chunks (as the transcript store would on append), parse
// them with the canonical parser, and fold them with the REAL shared display fold.
function foldUpdates(updates) {
  let offset = 0;
  const events = [];
  for (const u of updates) {
    const chunk = acpUpdateToDisplayChunk(u, { sessionAcp });
    if (chunk === null) continue;
    events.push(parseTranscriptEvent({ offset: offset++, chunk }));
  }
  return deriveDisplay(events);
}

// Typed narrowing helpers (plain JS): assert-or-throw so a wrong block kind fails
// the test loudly rather than reading `undefined`.
function asText(block) {
  assert.equal(block?.kind, 'text', `expected a text block, got ${block?.kind}`);
  return block;
}
function asTool(block) {
  assert.equal(block?.kind, 'tool', `expected a tool block, got ${block?.kind}`);
  return block;
}
const textBlocks = (blocks) => blocks.filter((b) => b.kind === 'text');

// ---------------------------------------------------------------------------
// Message identity: transport fragments of ONE message coalesce exactly.
// ---------------------------------------------------------------------------
test('fragmented single message (one messageId) reconstructs into one exact block', () => {
  // A word split ACROSS transport chunks ("hel" + "lo") — the core defect the
  // shared display fold fixes; the producer must carry the messageId so it folds.
  const parts = ['Hel', 'lo, ', 'wor', 'ld', '! ', 'This is ', 'one message.'];
  const blocks = foldUpdates(parts.map((t) => assistantChunk(t, 'm1')));
  assert.equal(blocks.length, 1);
  const block = asText(blocks[0]);
  // Exact concatenation — no injected whitespace, no trimming, byte-faithful.
  assert.equal(block.text, parts.join(''));
  assert.equal(block.role, 'assistant');
  assert.equal(block.messageId, 'm1');
});

test('two distinct same-speaker messages with distinct ids stay separate even when adjacent', () => {
  const blocks = foldUpdates([
    assistantChunk('First answer.', 'm1'),
    assistantChunk('Second, unrelated answer.', 'm2'),
  ]);
  const texts = textBlocks(blocks);
  assert.equal(texts.length, 2, 'distinct messageIds must NOT coalesce');
  assert.equal(asText(texts[0]).text, 'First answer.');
  assert.equal(asText(texts[1]).text, 'Second, unrelated answer.');
  assert.deepEqual(texts.map((b) => b.messageId), ['m1', 'm2']);
});

// ---------------------------------------------------------------------------
// Missing-metadata fallback: no fabricated identity, byte-identical legacy wire.
// ---------------------------------------------------------------------------
test('missing messageId falls back to adjacent-speaker coalescing (legacy)', () => {
  const parts = ['Str', 'eaming ', 'without', ' ids.'];
  const blocks = foldUpdates(parts.map((t) => assistantChunk(t)));
  assert.equal(blocks.length, 1);
  const block = asText(blocks[0]);
  assert.equal(block.text, parts.join(''));
  // No identity was fabricated.
  assert.equal(block.messageId, undefined);
});

test('a provider that omits messageId produces byte-identical bridge output (no wire change)', () => {
  // The documented legacy fallback: without identity the producer MUST emit exactly
  // what the canonical bridge emits, so no consumer/producer wire divergence.
  const updates = [
    assistantChunk('plain delta'),
    thoughtChunk('a thought'),
    userChunk('a user echo'),
    toolCall('call-1', 'grep', { pattern: 'x' }),
    toolResult('call-1', 'completed', { matches: 2 }),
    { sessionUpdate: 'plan', entries: [] }, // ignored → null on both paths
  ];
  for (const u of updates) {
    assert.equal(
      acpUpdateToDisplayChunk(u, { sessionAcp }),
      sessionAcp.acpUpdateToTranscriptChunk(u),
    );
  }
});

// ---------------------------------------------------------------------------
// Role / channel: reasoning folds to assistant; distinct ids keep blocks apart.
// ---------------------------------------------------------------------------
test('reasoning (thought) and assistant message fold to assistant but stay distinct via id', () => {
  const blocks = foldUpdates([
    thoughtChunk('Let me think about this.', 'think-1'),
    assistantChunk('Here is the answer.', 'msg-1'),
  ]);
  const texts = textBlocks(blocks);
  assert.equal(texts.length, 2);
  assert.deepEqual(texts.map((b) => b.role), ['assistant', 'assistant']);
  assert.deepEqual(texts.map((b) => b.text), ['Let me think about this.', 'Here is the answer.']);
});

test('user_message_chunk maps to a user-role block', () => {
  const blocks = foldUpdates([userChunk('user says hi', 'u1')]);
  const block = asText(blocks[0]);
  assert.equal(block.role, 'user');
  assert.equal(block.text, 'user says hi');
});

// ---------------------------------------------------------------------------
// Tool / permission ordering stays correct and paired; text does not merge across.
// ---------------------------------------------------------------------------
test('text/tool/text interleave in chronological order and tool pairs its result', () => {
  const blocks = foldUpdates([
    assistantChunk('Let me search. ', 'm1'),
    assistantChunk('One moment.', 'm1'),
    toolCall('call-1', 'ripgrep', { pattern: 'needle' }),
    toolResult('call-1', 'completed', { hits: 3 }),
    assistantChunk('Found it.', 'm2'),
  ]);
  assert.deepEqual(blocks.map((b) => b.kind), ['text', 'tool', 'text']);
  assert.equal(asText(blocks[0]).text, 'Let me search. One moment.');
  const tool = asTool(blocks[1]);
  assert.equal(tool.tool.name, 'ripgrep');
  assert.equal(tool.tool.result?.ok, true);
  assert.equal(asText(blocks[2]).text, 'Found it.');
});

test('a tool call BETWEEN same-message deltas breaks coalescing (boundary preserved)', () => {
  // Even with the SAME messageId, a tool card between two deltas is a coalescing
  // boundary, so the later delta opens a fresh block after the tool.
  const blocks = foldUpdates([
    assistantChunk('before ', 'm1'),
    toolCall('call-1', 'read', null),
    assistantChunk('after', 'm1'),
  ]);
  assert.deepEqual(blocks.map((b) => b.kind), ['text', 'tool', 'text']);
  assert.equal(asText(blocks[0]).text, 'before ');
  assert.equal(asText(blocks[2]).text, 'after');
});

// ---------------------------------------------------------------------------
// Delta/snapshot: the producer emits deltas, never a cumulative snapshot as delta.
// ---------------------------------------------------------------------------
test('message chunks are tagged mode:"delta" and carry the messageId on the wire', () => {
  const chunk = acpUpdateToDisplayChunk(assistantChunk('hi', 'm1'), { sessionAcp });
  const event = parseTranscriptEvent({ offset: 0, chunk });
  assert.equal(event.kind, 'message');
  assert.equal(event.mode, 'delta');
  assert.equal(event.messageId, 'm1');
  assert.equal(event.role, 'assistant');
  assert.equal(event.text, 'hi');
});

test('successive deltas APPEND (never replace) — no text doubling', () => {
  // The "never append a snapshot as a delta" guarantee, observed from the consumer:
  // two deltas of one message concatenate to exactly their sum.
  const blocks = foldUpdates([
    assistantChunk('abc', 'm1'),
    assistantChunk('def', 'm1'),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(asText(blocks[0]).text, 'abcdef');
});

// ---------------------------------------------------------------------------
// Idempotency: replayed/duplicate offsets never double the visible text.
// ---------------------------------------------------------------------------
test('duplicate/stale offsets are idempotent (replay does not double text)', () => {
  const chunkA = acpUpdateToDisplayChunk(assistantChunk('abc', 'm1'), { sessionAcp });
  const chunkB = acpUpdateToDisplayChunk(assistantChunk('def', 'm1'), { sessionAcp });
  // Offsets 0,1 then a REPLAY of 0,1 (duplicate delivery / reconnect).
  const events = [
    parseTranscriptEvent({ offset: 0, chunk: chunkA }),
    parseTranscriptEvent({ offset: 1, chunk: chunkB }),
    parseTranscriptEvent({ offset: 0, chunk: chunkA }),
    parseTranscriptEvent({ offset: 1, chunk: chunkB }),
  ];
  const blocks = deriveDisplay(events);
  assert.equal(blocks.length, 1);
  assert.equal(asText(blocks[0]).text, 'abcdef');
});

// ---------------------------------------------------------------------------
// No text loss / no injected whitespace across many small multibyte fragments.
// ---------------------------------------------------------------------------
test('unicode + newline-heavy fragments reconstruct byte-faithfully', () => {
  const parts = ['# Title\n\n', 'Café ', '☕ ', 'дела', ' — ', 'line1\n', 'line2', '\n\n```js\nconst x=1;\n```'];
  const blocks = foldUpdates(parts.map((t) => assistantChunk(t, 'doc')));
  assert.equal(blocks.length, 1);
  assert.equal(asText(blocks[0]).text, parts.join(''));
});

// ---------------------------------------------------------------------------
// Ignored updates carry no canonical meaning → null (nothing appended).
// ---------------------------------------------------------------------------
test('ignored updates (plan, non-text chunk, intermediate tool update) return null', () => {
  assert.equal(acpUpdateToDisplayChunk({ sessionUpdate: 'plan', entries: [] }, { sessionAcp }), null);
  assert.equal(
    acpUpdateToDisplayChunk({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } }, { sessionAcp }),
    null,
  );
  assert.equal(
    acpUpdateToDisplayChunk(toolResult('call-1', 'in_progress', null), { sessionAcp }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Robustness: a broken shared surface degrades to the canonical bridge, never throws.
// ---------------------------------------------------------------------------
test('a throwing classifier degrades to the canonical bridge output', () => {
  const throwingAcp = {
    classifyUpdate() { throw new Error('boom'); },
    acpUpdateToTranscriptChunk: sessionAcp.acpUpdateToTranscriptChunk,
  };
  const u = assistantChunk('resilient', 'm1');
  assert.equal(
    acpUpdateToDisplayChunk(u, { sessionAcp: throwingAcp }),
    sessionAcp.acpUpdateToTranscriptChunk(u),
  );
});
