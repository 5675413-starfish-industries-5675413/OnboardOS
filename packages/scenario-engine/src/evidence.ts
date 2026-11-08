/**
 * Pure evidence-currency rules. Staleness is NEVER stored: it is derived at read
 * time by comparing what a run tested against what the session holds now, so a
 * later config edit can never mutate or delete historical evidence.
 */
import type { WorkplaceState } from "./types.js";

export interface RunIdentity {
  readonly configRevision: number;
  readonly configHash: string;
  readonly suiteVersion: number;
}

/** A run is current iff revision, hash AND suite version all match the session now. */
export function isCurrentRun(
  run: RunIdentity,
  state: Pick<WorkplaceState, "configRevision" | "configHash">,
  currentSuiteVersion: number,
): boolean {
  return (
    run.configRevision === state.configRevision &&
    run.configHash === state.configHash &&
    run.suiteVersion === currentSuiteVersion
  );
}
