/**
 * The HIDDEN INC-104 test suite.
 *
 * CONFIDENTIAL: thresholds and expectations live ONLY in this runner. They are
 * never imported by the API, the web app, the contracts, or any employee-facing
 * payload. Case ids/messages are deliberately neutral so results do not reveal
 * the thresholds (the employee learns pass/fail, not the answer).
 */
import type { IncidentConfig } from "@onboardos/contracts";
import { REQUEST_TIMEOUT_MAX_MS, REQUEST_TIMEOUT_MIN_MS } from "@onboardos/contracts";
import type { RunnerCase } from "@onboardos/scenario-engine";

/** The scenario version this suite was written for; the suite is only valid for exactly this pair. */
export const INC104_SCENARIO_ID = "inc-104";
export const INC104_SCENARIO_VERSION = 1;
export const INC104_SUITE_ID = "inc-104-checkout-timeout";
export const INC104_SUITE_VERSION = 1;

// Hidden upstream latency profiles the service must survive.
const PROFILE_A_UPSTREAM_MS = 1200;
const PROFILE_B_UPSTREAM_MS = 1600;

const pass = (caseId: string, name: string, message: string): RunnerCase => ({ caseId, name, status: "PASS", message });
const fail = (caseId: string, name: string, message: string): RunnerCase => ({ caseId, name, status: "FAIL", message });

/**
 * Run every case against a VALIDATED config snapshot. `hashMatches` is the
 * runner's independent recomputation of the snapshot hash.
 */
export function runInc104Suite(config: IncidentConfig, hashMatches: boolean): RunnerCase[] {
  const t = config.request_timeout_ms;
  const cases: RunnerCase[] = [];

  cases.push(
    Number.isInteger(t)
      ? pass("schema-valid", "Configuration is well-formed", "The configuration has the correct shape.")
      : fail("schema-valid", "Configuration is well-formed", "The configuration is malformed."),
  );
  cases.push(
    t >= REQUEST_TIMEOUT_MIN_MS && t <= REQUEST_TIMEOUT_MAX_MS
      ? pass("within-policy", "Configuration is within policy", "The value is inside the allowed range.")
      : fail("within-policy", "Configuration is within policy", "The value is outside the allowed range."),
  );
  cases.push(
    hashMatches
      ? pass("revision-hash-matches", "Snapshot integrity", "The tested snapshot matches its recorded hash.")
      : fail("revision-hash-matches", "Snapshot integrity", "The tested snapshot does not match its recorded hash."),
  );
  cases.push(
    t >= PROFILE_A_UPSTREAM_MS
      ? pass("latency-profile-a", "Tolerates slow upstream (profile A)", "Requests completed before timing out.")
      : fail("latency-profile-a", "Tolerates slow upstream (profile A)", "Requests timed out before the upstream responded."),
  );
  cases.push(
    t >= PROFILE_B_UPSTREAM_MS
      ? pass("latency-profile-b", "Tolerates slow upstream (profile B)", "Requests completed before timing out.")
      : fail("latency-profile-b", "Tolerates slow upstream (profile B)", "Requests timed out before the upstream responded."),
  );
  return cases;
}
