// Producer-side ACP → transcript-chunk mapping that PRESERVES message boundaries
// (jwulf/c8ctl-plugin-nano#206), built on top of the published shared contract
// from nanobpm/nano-ide#566 (@nanobpm/agentic >= 0.14.0).
//
// The problem: streaming ACP output arrives as arbitrary `agent_message_chunk`
// deltas whose transport boundaries are NOT message boundaries. The canonical
// bridge `acpUpdateToTranscriptChunk` (nanobpm/nano-ide#534) folds an ACP
// `session/update` into the exact transcript-chunk bytes the cockpit decodes, but
// it drops the ACP `messageId` that the shared classifier already extracts — so a
// consumer folding those chunks through the shared ordered-display derivation
// (`deriveDisplay`, #566) cannot tell a continuing delta of ONE message from the
// first delta of a NEW same-speaker message. Two distinct assistant messages
// emitted back-to-back would wrongly coalesce into one block; a single message
// split across chunks reconstructs correctly either way.
//
// This module carries the AVAILABLE producer semantics — message identity
// (`messageId`), role/channel and delta/snapshot mode — into the canonical
// additive `MessageEvent` fields the shared contract added in #566, using the
// SHARED classifier (`classifyUpdate`) and the SHARED canonical encoder
// (`encodeTranscriptEvent`). It does NOT hand-roll a parallel wire grammar,
// grouping implementation or heuristic sentence splitter: the marker, version,
// kinds and additive fields all come from the package.
//
// Fidelity contract (the documented legacy fallback):
//  - ACP `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk`
//    text is an incremental DELTA (never a cumulative snapshot for the supported
//    ACP providers), so a message event is tagged `mode: "delta"` — a cumulative
//    snapshot is NEVER emitted as an additive delta (the #566 "never append a
//    snapshot as a delta" rule).
//  - Where the provider exposes a `messageId`, it is carried so the display fold
//    groups a message's fragments and separates two distinct same-speaker
//    messages even when their transport chunks are adjacent.
//  - Where the provider omits `messageId` (a documented ACP fidelity gap), NO
//    identity is fabricated and NO boundary is inferred from delays/punctuation:
//    the chunk is emitted through the canonical bridge UNCHANGED (byte-identical
//    to the pre-#206 wire), and the display fold's adjacent-same-speaker
//    coalescing is the legacy fallback.
//  - Tool-call / tool-result / permission / ignored updates are delegated to the
//    canonical bridge untouched, so tool and permission events stay correctly
//    ordered and paired and raw replay is unchanged.

import { sessionAcp as defaultSessionAcp, transcript as defaultTranscript } from './agentic.mjs';

// Map the shared classifier's message role to a canonical `TranscriptRole`. ACP's
// `reasoning` (an `agent_thought_chunk`) has no distinct transcript role, so — like
// the canonical bridge `acpUpdateToTranscriptChunk` — it folds to `assistant`,
// which `deriveDisplay` renders as a message block rather than dropping to raw
// bytes. This mirrors the package bridge exactly so the producer never diverges
// from the shared role mapping.
function transcriptRole(acpRole) {
  return acpRole === 'user' ? 'user' : 'assistant';
}

// A non-empty string, else null. `messageId` is optional on the ACP update and the
// shared classifier already normalises it to `string | null`.
function nonBlankId(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Map one raw ACP `session/update` `update` object to the canonical transcript-chunk
 * bytes a producer appends, carrying the available message identity / role / delta
 * semantics into the shared additive `MessageEvent` contract (#566). Returns `null`
 * for an update with no canonical meaning (an `ignored` classification), exactly like
 * the underlying bridge, so a caller skips it.
 *
 * Pure and total: any classifier or encoder throw degrades to the canonical bridge,
 * and a bridge throw is itself caught (yielding `null`), so the producer hot path
 * never crashes on one malformed update.
 *
 * @param {unknown} update The raw ACP `session/update` `params.update` object.
 * @param {object} [deps]
 * @param {object} [deps.sessionAcp]  The shared ACP surface (`classifyUpdate` +
 *   `acpUpdateToTranscriptChunk`); defaults to the package bridge.
 * @param {object} [deps.transcript]  The shared transcript surface
 *   (`encodeTranscriptEvent`); defaults to the package transcript module.
 * @returns {string | null} The canonical transcript-chunk bytes, or `null`.
 */
export function acpUpdateToDisplayChunk(update, deps = {}) {
  const sessionAcp = deps.sessionAcp || defaultSessionAcp;
  const transcript = deps.transcript || defaultTranscript;

  const classify = typeof sessionAcp?.classifyUpdate === 'function' ? sessionAcp.classifyUpdate : null;
  const encode = typeof transcript?.encodeTranscriptEvent === 'function' ? transcript.encodeTranscriptEvent : null;
  const bridge = typeof sessionAcp?.acpUpdateToTranscriptChunk === 'function' ? sessionAcp.acpUpdateToTranscriptChunk : null;

  // Fallback to the canonical bridge output for this update. Never throws.
  const viaBridge = () => {
    if (!bridge) return null;
    try { return bridge(update); }
    catch { return null; }
  };

  // Without the shared classifier + encoder we cannot enrich the message event, so
  // the byte-identical canonical bridge output is the only correct behaviour.
  if (!classify || !encode) return viaBridge();

  let classified;
  try { classified = classify(update); }
  catch { return viaBridge(); }

  // Only message chunks carry identity/boundary semantics worth enriching. Every
  // other classification (tool-call, tool-result, ignored) is delegated to the
  // canonical bridge UNCHANGED — tool/permission ordering and raw replay untouched.
  if (!classified || classified.kind !== 'message') return viaBridge();

  const messageId = nonBlankId(classified.messageId);

  // No provider-supplied identity → do NOT fabricate one or infer a boundary.
  // Emit through the canonical bridge unchanged (byte-identical to the pre-#206
  // wire) and let the display fold's adjacent-same-speaker coalescing be the
  // documented legacy fallback.
  if (messageId === null) return viaBridge();

  // Carry the available semantics into the additive `MessageEvent` fields: the
  // producer identity (`messageId`) so the fold groups this message's fragments and
  // separates distinct same-speaker messages, and `mode: "delta"` because ACP
  // message chunks are incremental deltas — never a cumulative snapshot. No `offset`
  // is supplied here; the real store offset is assigned on append (matching every
  // other `encodeTranscriptEvent` call site).
  const event = {
    kind: 'message',
    role: transcriptRole(classified.role),
    text: classified.text,
    messageId,
    mode: 'delta',
  };

  try { return encode(event); }
  catch { return viaBridge(); }
}
