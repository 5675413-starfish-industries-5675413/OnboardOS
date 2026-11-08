/**
 * @onboardos/scenario-engine -- the pure deterministic scenario engine.
 *
 * No AWS SDK, no network, no clock, no randomness: Bedrock cannot influence it.
 * Its only runtime imports are zod (runner protocol) and node:crypto's SHA-256
 * (a pure function) for canonical config hashing.
 */
export * from "./types.js";
export {
  MAX_CONFIG_REVISIONS,
  MAX_STATE_VERSION,
  MAX_TEST_RUNS,
  createSession,
  reduceScenario,
  startSession,
} from "./reducer.js";
export { CONFIG_HASH_PATTERN, canonicalConfigJson, configHash, validateConfig } from "./config.js";
export type { ConfigValidation } from "./config.js";
export { isCurrentRun } from "./evidence.js";
export type { RunIdentity } from "./evidence.js";
export * from "./runnerProtocol.js";
