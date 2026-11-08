/**
 * Persisted record shapes, their validation, and the projections that leave the API.
 *
 * Nothing read from DynamoDB is trusted by TypeScript cast. Every record is
 * parsed with Zod and its key attributes are cross-checked against its content;
 * a record that fails is treated as absent (lists) or as a server fault
 * (single fetch). Nothing malformed is ever returned or authorized against.
 *
 * Outbound bodies are produced by parsing through the shared contract schemas,
 * which STRIP unknown keys -- so an internal attribute (index keys, manager
 * identity, suite ids) cannot leak by accident.
 */

import { z } from "zod";
import {
  AssignmentStatusSchema,
  AssignmentViewSchema,
  IncidentConfigSchema,
  MembershipStatusSchema,
  OrgRoleSchema,
  ScenarioIdSchema,
  SessionPhaseSchema,
  SessionViewSchema,
  UserSubSchema,
  ViewedSchema,
  type AssignmentView,
  type SessionView,
} from "@onboardos/contracts";
import type { DomainEvent, PublishedScenario, WorkplaceState } from "@onboardos/scenario-engine";
import { ASSIGNMENT_ID_PATTERN, SESSION_ID_PATTERN } from "./ids.js";

// ---------------------------------------------------------------------------
// Key builders (single source of truth for the access patterns in docs/04)
// ---------------------------------------------------------------------------

export const keys = {
  member: (orgId: string, sub: string) => ({ PK: `ORG#${orgId}`, SK: `MEMBER#${sub}` }),
  assignment: (assignmentId: string) => ({ PK: `ASSIGN#${assignmentId}`, SK: "META" as const }),
  session: (sessionId: string) => ({ PK: `SESSION#${sessionId}`, SK: "STATE" as const }),
  event: (sessionId: string, sequence: number) => ({
    PK: `SESSION#${sessionId}`,
    SK: `SEQ#${String(sequence).padStart(10, "0")}`,
  }),
  /** GSI1: an employee's assignments within an organization. */
  employeeIndex: (orgId: string, employeeSub: string) => `ORG#${orgId}#EMP#${employeeSub}`,
  /**
   * GSI2: a manager's partition. Assignment entries use the "ASSIGN#" sort-key
   * prefix. The frozen design reserves "REVIEWABLE#" entries in the same
   * partition for the review queue; that slice will move an assignment's GSI2SK
   * to that prefix when it becomes reviewable.
   */
  managerIndex: (orgId: string, managerSub: string) => `ORG#${orgId}#MANAGER#${managerSub}`,
};

// ---------------------------------------------------------------------------
// Membership (read-only here; written only by operator tooling)
// ---------------------------------------------------------------------------

const MemberItemSchema = z.looseObject({
  PK: z.string(),
  SK: z.string().startsWith("MEMBER#"),
  role: OrgRoleSchema,
  status: MembershipStatusSchema,
  // Required (not defaulted): a membership without a valid team list is malformed.
  teamIds: z.array(z.string()),
  preferredUsername: z.string().optional(),
});

export interface Member {
  organizationId: string;
  userSub: string;
  role: z.infer<typeof OrgRoleSchema>;
  status: z.infer<typeof MembershipStatusSchema>;
  teamIds: string[];
  /** Safe-to-show name. Never the email address. */
  displayName: string;
}

/** Parse a membership item. The org and sub come from the KEY, which is authoritative. */
export function parseMember(item: unknown): Member | null {
  const parsed = MemberItemSchema.safeParse(item);
  if (!parsed.success) return null;
  const { PK, SK, role, status, teamIds, preferredUsername } = parsed.data;
  if (!PK.startsWith("ORG#")) return null;
  const organizationId = PK.slice("ORG#".length);
  const userSub = SK.slice("MEMBER#".length);
  if (!UserSubSchema.safeParse(userSub).success) return null;
  return {
    organizationId,
    userSub,
    role,
    status,
    teamIds,
    displayName: preferredUsername && preferredUsername.trim() ? preferredUsername.trim() : "Employee",
  };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

const AssignmentRecordSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.literal("META"),
    entityType: z.literal("ASSIGNMENT"),
    assignmentId: z.string().regex(ASSIGNMENT_ID_PATTERN),
    organizationId: z.string(),
    scenarioId: ScenarioIdSchema,
    scenarioVersion: z.number().int().positive(),
    scenarioTitle: z.string(),
    employeeSub: UserSubSchema,
    employeeDisplayName: z.string(),
    assignedBySub: UserSubSchema,
    status: AssignmentStatusSchema,
    sessionId: z.string().regex(SESSION_ID_PATTERN).nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    updatedAt: z.string(),
    GSI1PK: z.string(),
    GSI1SK: z.string(),
    GSI2PK: z.string(),
    GSI2SK: z.string(),
  })
  // Keys must agree with content, or the record was written wrongly / tampered with.
  .refine(
    (r) =>
      r.PK === keys.assignment(r.assignmentId).PK &&
      r.GSI1PK === keys.employeeIndex(r.organizationId, r.employeeSub) &&
      r.GSI2PK === keys.managerIndex(r.organizationId, r.assignedBySub),
    { message: "assignment keys do not match content" },
  );

export type AssignmentRecord = z.infer<typeof AssignmentRecordSchema>;

export function parseAssignment(item: unknown): AssignmentRecord | null {
  const parsed = AssignmentRecordSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

export function buildAssignmentRecord(input: {
  assignmentId: string;
  organizationId: string;
  scenario: PublishedScenario;
  employeeSub: string;
  employeeDisplayName: string;
  assignedBySub: string;
  now: string;
}): AssignmentRecord {
  const { assignmentId, organizationId, scenario, employeeSub, employeeDisplayName, assignedBySub, now } = input;
  return {
    ...keys.assignment(assignmentId),
    entityType: "ASSIGNMENT",
    assignmentId,
    organizationId,
    scenarioId: scenario.content.scenarioId,
    scenarioVersion: scenario.content.version,
    scenarioTitle: scenario.content.title,
    employeeSub,
    employeeDisplayName,
    assignedBySub,
    status: "ASSIGNED",
    sessionId: null,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    GSI1PK: keys.employeeIndex(organizationId, employeeSub),
    GSI1SK: `ASSIGN#${now}#${assignmentId}`,
    GSI2PK: keys.managerIndex(organizationId, assignedBySub),
    GSI2SK: `ASSIGN#${now}#${assignmentId}`,
  };
}

/**
 * Client projection. The employee sees their own assignment without the
 * `employee` block; managers/admins get it. The assigning manager's identity
 * and all index attributes are never included.
 */
export function toAssignmentView(r: AssignmentRecord, includeEmployee: boolean): AssignmentView {
  return AssignmentViewSchema.parse({
    assignmentId: r.assignmentId,
    organizationId: r.organizationId,
    scenarioId: r.scenarioId,
    scenarioVersion: r.scenarioVersion,
    scenarioTitle: r.scenarioTitle,
    status: r.status,
    sessionId: r.sessionId,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    ...(includeEmployee
      ? { employee: { userSub: r.employeeSub, displayName: r.employeeDisplayName } }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Session state and events
// ---------------------------------------------------------------------------

const WorkplaceStateSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.literal("STATE"),
    entityType: z.literal("SESSION_STATE"),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    assignmentId: z.string().regex(ASSIGNMENT_ID_PATTERN),
    organizationId: z.string(),
    employeeSub: UserSubSchema,
    scenarioId: ScenarioIdSchema,
    scenarioVersion: z.number().int().positive(),
    phase: SessionPhaseSchema,
    stateVersion: z.number().int().nonnegative(),
    config: IncidentConfigSchema,
    viewed: ViewedSchema,
    startedAt: z.string().nullable(),
    updatedAt: z.string(),
  })
  .refine((s) => s.PK === keys.session(s.sessionId).PK, { message: "session key does not match content" });

/** Parse a stored session into the engine's state type (extra storage attributes dropped). */
export function parseSessionState(item: unknown): WorkplaceState | null {
  const parsed = WorkplaceStateSchema.safeParse(item);
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    sessionId: d.sessionId,
    assignmentId: d.assignmentId,
    organizationId: d.organizationId,
    employeeSub: d.employeeSub,
    scenarioId: d.scenarioId,
    scenarioVersion: d.scenarioVersion,
    phase: d.phase,
    stateVersion: d.stateVersion,
    config: d.config,
    viewed: d.viewed,
    startedAt: d.startedAt,
    updatedAt: d.updatedAt,
  };
}

export function sessionItem(state: WorkplaceState): Record<string, unknown> {
  return { ...keys.session(state.sessionId), entityType: "SESSION_STATE", ...state };
}

export function eventItem(state: WorkplaceState, event: DomainEvent): Record<string, unknown> {
  return {
    ...keys.event(event.sessionId, event.sequence),
    entityType: "SESSION_EVENT",
    sessionId: event.sessionId,
    organizationId: state.organizationId,
    actorSub: event.actorSub,
    type: event.type,
    stateVersion: event.sequence,
    occurredAt: event.occurredAt,
    payload: event.payload,
  };
}

/** Client projection of a session. Parsing through the contract strips anything not public. */
export function toSessionView(state: WorkplaceState, scenario: PublishedScenario): SessionView {
  return SessionViewSchema.parse({
    sessionId: state.sessionId,
    assignmentId: state.assignmentId,
    organizationId: state.organizationId,
    scenarioId: state.scenarioId,
    scenarioVersion: state.scenarioVersion,
    phase: state.phase,
    stateVersion: state.stateVersion,
    config: state.config,
    viewed: state.viewed,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    scenario: scenario.content,
  });
}
