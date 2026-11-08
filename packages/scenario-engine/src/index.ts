/**
 * @onboardos/scenario-engine -- the pure deterministic scenario engine.
 *
 * Imports nothing at runtime: no AWS SDK, no I/O. Bedrock cannot influence it.
 */
export * from "./types.js";
export { MAX_STATE_VERSION, createSession, reduceScenario, startSession } from "./reducer.js";
