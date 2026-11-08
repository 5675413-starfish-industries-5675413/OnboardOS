import type { Rejection } from "@onboardos/scenario-engine";
import { HttpError } from "../http.js";

/**
 * How each engine rejection is reported. Typed as a total Record so adding an
 * engine rejection code without deciding its HTTP mapping fails to compile.
 */
export const REJECTION_STATUS: Record<Rejection["code"], { status: number; code: string }> = {
  VERSION_CONFLICT: { status: 409, code: "VERSION_CONFLICT" },
  INVALID_TRANSITION: { status: 422, code: "INVALID_TRANSITION" },
  UNKNOWN_OBJECT: { status: 422, code: "UNKNOWN_OBJECT" },
  LIMIT_REACHED: { status: 429, code: "LIMIT_REACHED" },
  INVALID_CONFIG: { status: 400, code: "INVALID_CONFIG" },
  CONFIG_OUT_OF_POLICY: { status: 422, code: "CONFIG_OUT_OF_POLICY" },
  CONFIG_UNCHANGED: { status: 422, code: "CONFIG_UNCHANGED" },
  RUN_IN_PROGRESS: { status: 409, code: "RUN_IN_PROGRESS" },
  RUN_LIMIT_REACHED: { status: 429, code: "RUN_LIMIT_REACHED" },
  REVISION_LIMIT_REACHED: { status: 429, code: "REVISION_LIMIT_REACHED" },
  ALREADY_DECIDED: { status: 409, code: "ALREADY_DECIDED" },
  // The API authorizes ownership first, so these indicate a bug or tampering: do not explain.
  NOT_OWNER: { status: 404, code: "NOT_FOUND" },
  NOT_AUTHORIZED: { status: 404, code: "NOT_FOUND" },
  SCENARIO_MISMATCH: { status: 500, code: "INTERNAL_ERROR" },
};

/** Convert an engine rejection into the HttpError to throw (5xx mapped codes become internal faults). */
export function rejectionToError(rejection: Rejection): Error {
  const mapped = REJECTION_STATUS[rejection.code];
  if (mapped.status >= 500) return new Error(`engine rejection ${rejection.code}`);
  return new HttpError(mapped.status, mapped.code, rejection.message);
}
