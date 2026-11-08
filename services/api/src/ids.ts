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

/**
 * One deterministic id per (session, run number). The 4-digit number keeps
 * ids sortable in creation order; the hash suffix makes them unguessable-ish
 * and keeps two concurrent requests for the same slot colliding on the SAME id
 * (so the conditional write, not a duplicate, decides the winner).
 */
export function testRunIdFor(sessionId: string, runNumber: number): string {
  return `run_${String(runNumber).padStart(4, "0")}_${digest(`${sessionId}|testrun|${runNumber}`).slice(0, 12)}`;
}

export const SUBMISSION_ID_PATTERN = /^sub_\d{2}_[0-9a-f]{32}$/;

/**
 * A submission id ENCODES its assignment and attempt: `sub_<attempt>_<assignment hex>`.
 * That makes `GET /v1/reviews/{submissionId}` a consistent key lookup
 * (`ASSIGN#<id> / SUBMISSION#<attempt>`) with no scan and no extra index, and makes
 * the id deterministic per attempt, so a retry can only ever target the same record.
 * Like every id here it is NOT a security control: each read re-checks authorization.
 */
export function submissionIdFor(assignmentId: string, attempt: number): string {
  const hex = assignmentId.replace(/^asg_/, "");
  return `sub_${String(attempt).padStart(2, "0")}_${hex}`;
}

/** Inverse of {@link submissionIdFor}, or null if the id is not well formed. */
export function parseSubmissionId(id: string): { assignmentId: string; attempt: number } | null {
  if (!SUBMISSION_ID_PATTERN.test(id)) return null;
  const attempt = Number(id.slice(4, 6));
  if (attempt < 1) return null;
  return { assignmentId: `asg_${id.slice(7)}`, attempt };
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
