// Single import surface for the Nano agentic-visibility plane (ADR 0056 —
// Magikcraft/nano-bpm#670) inside this plugin.
//
// This is slice C0 of the agent-visibility epic (jwulf/c8ctl-plugin-nano#38).
// The sibling slices — C2 presence (#41), C3 PTY relay (#42) and C4 buffer
// (#43) — MUST import the wire contract and the worker client through *this*
// module rather than reaching into `@nanobpm/agentic` subpaths or
// `@nanobpm/urban-agent-client` directly. One place to import, one place to
// swap when the upstream packaging changes.
//
// Nothing here is re-declared: every frame, lane, family, token, vocab and
// payload type is CONSUMED from the published `@nanobpm/agentic` package, and
// the worker-side channel client is CONSUMED from `@nanobpm/urban-agent-client`.
// The shared conformance corpus (`@nanobpm/agentic/protocol/conformance`) keeps
// this repo's consumption in lock-step with the hub — see
// `agentic-conformance.test.mjs`.

// ---------------------------------------------------------------------------
// Wire contract — @nanobpm/agentic/protocol (S0, the single source of truth).
// The codec, routing-token grammar, vocab schema and per-family payload
// validators. These resolve to the package's compiled `dist`, so they load
// under stock Node.
// ---------------------------------------------------------------------------
export {
  // message families
  MESSAGE_FAMILIES,
  FAMILY_CODES,
  familyForCode,
  isMessageFamily,
  // QoS lanes
  QOS_LANES,
  LANE_CODES,
  laneForCode,
  lanePriority,
  isQosLane,
  compareFrameOrder,
  // frame codec
  encodeFrame,
  decodeFrame,
  FrameDecodeError,
  FrameEncodeError,
  FRAME_MAGIC,
  FRAME_VERSION,
  FRAME_HEADER_BYTES,
  MAX_SEQ,
  // routing tokens
  parseToken,
  formatToken,
  isValidToken,
  isSegmentName,
  isSeatLabel,
  TokenParseError,
  // vocab schema
  validateVocabDocument,
  // per-family payload contracts
  validatePayload,
  // language-neutral hex helpers (used to hold the codec to the corpus)
  bytesToHex,
  hexToBytes,
} from '@nanobpm/agentic/protocol';

// ---------------------------------------------------------------------------
// Visibility families. Each is re-exported wholesale so a consumer picks the
// namespace it needs (channel transport, presence, relay lane, transcript)
// without re-declaring any of it. Namespaced re-exports keep the surface tidy
// and avoid symbol collisions between the families.
// ---------------------------------------------------------------------------
export * as channel from '@nanobpm/agentic/channel';
export * as presence from '@nanobpm/agentic/presence';
export * as relay from '@nanobpm/agentic/relay';
export * as transcript from '@nanobpm/agentic/transcript';

// ---------------------------------------------------------------------------
// Worker-side channel client — @nanobpm/urban-agent-client.
//
// The client's published `dist/protocol.js` imports the contract from
// `@nanobpm/agentic/source/protocol` (raw TypeScript) on the assumption the
// consumer runs under a type-stripping loader. Stock Node — which this repo's
// `node --test` uses — refuses to strip types under `node_modules`
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a *static* re-export of the
// client would make this whole surface fail to load. To keep C0's surface
// loadable everywhere while still routing all client consumption through one
// swap point, the client is exposed behind a lazy async loader. The slice that
// actually opens the channel (C2, #41) awaits it from the code path that runs
// under the appropriate loader/build.
//
// @typedef {import('@nanobpm/urban-agent-client')} AgenticClientModule
/** @type {Promise<AgenticClientModule> | undefined} */
let clientModulePromise;

/**
 * Load the published worker-side agentic channel client
 * (`@nanobpm/urban-agent-client`). Memoised so repeated calls share one module
 * instance. Import the client only through this accessor so there is a single
 * place to consume it from across the plugin.
 *
 * @returns {Promise<AgenticClientModule>} the client module namespace, exposing
 *   `connectAgenticChannel`, `AgenticClient`, `OutboundRing`, the websocket
 *   transport and the re-exported protocol symbols.
 */
export function loadAgenticClient() {
  if (clientModulePromise === undefined) {
    clientModulePromise = import('@nanobpm/urban-agent-client');
  }
  return clientModulePromise;
}
