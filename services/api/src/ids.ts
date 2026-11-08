/**
 * Deterministic identifiers.
 *
 * Assignment and session ids are derived (SHA-256) from the facts that define
 * them, which makes creation naturally idempotent: retrying "assign INC-104 to
 * this employee" or "start this assignment" computes the same id and hits the
 * same conditional write instead of creating a duplicate.
 *
 * Ids are opaque and are NOT a security control. Every read re-checks
 * ownership and membership; guessing an id grants nothing.
 */

import { createHash } from "node:crypto";

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

export const ORG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ASSIGNMENT_ID_PATTERN = /^asg_[0-9a-f]{32}$/;
export const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/;

/** One assignment per (organization, scenario version, employee). The inputs cannot contain "|". */
export function assignmentIdFor(
  organizationId: string,
  scenarioId: string,
  scenarioVersion: number,
  employeeSub: string,
): string {
  return `asg_${digest(`${organizationId}|${scenarioId}|v${scenarioVersion}|${employeeSub}`)}`;
}

/** One session per assignment attempt. Only attempt 1 exists in this slice. */
export function sessionIdFor(assignmentId: string, attempt = 1): string {
  return `ses_${digest(`${assignmentId}|attempt|${attempt}`)}`;
}
