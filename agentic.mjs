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

// Node's module-customization registrar, used lazily by `loadAgenticClient()`
// to install the source→dist resolve hook before the worker client loads.
import { register as moduleRegister } from 'node:module';

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
  // additive capability/version negotiation (claim/release degrade gracefully)
  PROTOCOL_VERSION,
  PROTOCOL_FEATURES,
  LOCAL_ADVERTISEMENT,
  parseAdvertisement,
  negotiate,
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

// ACP → transcript bridge (nanobpm/nano-ide#534). The canonical, pure wire seam
// that turns one raw ACP `session/update` into the exact `{ nwfTranscriptEvent:
// 1, kind, … }` transcript-chunk bytes the cockpit decodes — `classifyUpdate`
// composed with `encodeTranscriptEvent` behind the single `acpUpdateToTranscriptChunk`
// helper. The ACP executor (`spawnCaptureAcp`) consumes it through THIS surface
// instead of hand-rolling an envelope grammar, so there is one producer of the
// wire and the shared conformance corpus pins it to the hub.
export * as sessionAcp from '@nanobpm/agentic/session/acp';

// ---------------------------------------------------------------------------
// Demand read — @nanobpm/agentic/demand.
//
// The read-only C8 REST mirror of the engine's deployed `taskDefinition` leaves
// (ADR 0056 S4). `nano work --auto` (jwulf/c8ctl-plugin-nano#66) consumes its
// `httpC8RestReader` to enumerate deployed process definitions and read each
// one's BPMN XML straight from the engine the worker already talks to — the
// zero-config enrolment source. The header-filter that narrows those leaves to
// *agent* job types lives in the plugin (`scanAgentTaskLeaves`), extending the
// package's type/element/process-only scanner with a `zeebe:taskHeaders` read.
// ---------------------------------------------------------------------------
export * as demand from '@nanobpm/agentic/demand';

// ---------------------------------------------------------------------------
// Ownership/presence EMIT client — @nanobpm/agentic/emit (nano-ide#557).
//
// The blessed client-side emitter: ONE multiplexed host connection that N
// instances share, emitting register/heartbeat/deregister/claim/release and the
// relay transcript sink with an EXPLICIT `instance` per frame, owning its own
// reconnect resync and additive version negotiation. `agentic-endpoint.mjs`
// builds the plugin's concrete `RawEmitClient` on this instead of hand-rolling a
// parallel client-ownership layer. `composeStreamId`/`parseStreamId` are the one
// injective transcript-stream-id codec both this producer (routing inbound steer
// back to `{instance, jobKey}`) and the nano-workforce consumer derive from.
// ---------------------------------------------------------------------------
export {
  AgenticEmitClient,
  composeStreamId,
  parseStreamId,
} from '@nanobpm/agentic/emit';

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
// swap point, the client is exposed behind a lazy async loader.
//
// C2 (#41) resolves that constraint HERE, at the single swap point: before the
// client's module graph loads, `loadAgenticClient()` registers a resolve hook
// (`agentic-loader-hook.mjs`) that redirects the client's raw-`.ts`
// `@nanobpm/agentic/source/*` imports to the compiled `@nanobpm/agentic/*`
// `dist` exports. Source and dist are the same S0 contract (one shared
// conformance corpus), so the client loads and runs under stock Node with no
// change in behaviour. When the client is republished to import agentic's dist
// directly, the redirect self-neutralises.
//
// @typedef {import('@nanobpm/urban-agent-client')} AgenticClientModule
/** @type {Promise<AgenticClientModule> | undefined} */
let clientModulePromise;

// Guards single registration of the source→dist resolve hook (idempotent).
let sourceRedirectRegistered = false;

/**
 * Register the `@nanobpm/agentic/source/*` → `dist` resolve hook exactly once,
 * so the worker client is importable under stock Node. Safe to call repeatedly;
 * only the first call registers. Runs before any `import()` of the client so the
 * hook is active for the client's whole module graph.
 */
function ensureClientLoadable() {
  if (sourceRedirectRegistered) return;
  sourceRedirectRegistered = true;
  moduleRegister('./agentic-loader-hook.mjs', import.meta.url);
}

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
    ensureClientLoadable();
    clientModulePromise = import('@nanobpm/urban-agent-client');
  }
  return clientModulePromise;
}
