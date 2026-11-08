/**
 * DynamoDB access for assignments, sessions and events.
 *
 * Every access is a key lookup, a bounded partition query, or a GSI query: there
 * is no Scan anywhere, and no operation that spans tenants. Writes that must
 * stay consistent (session + event + assignment status) are single
 * TransactWriteItems calls with explicit conditions.
 *
 * Functions return raw items; callers parse them with the validators in
 * records.ts (nothing here is trusted by cast).
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Db } from "./deps.js";
import { keys } from "./records.js";

type Item = Record<string, unknown>;

export function isConditionalFailure(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "ConditionalCheckFailedException";
}

export function isTransactionCanceled(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TransactionCanceledException";
}

// ---------------------------------------------------------------------------
// Membership (read-only)
// ---------------------------------------------------------------------------

export async function getMemberItem(db: Db, orgId: string, sub: string): Promise<Item | undefined> {
  const r = await db.client.send(
    new GetCommand({ TableName: db.coreTable, Key: keys.member(orgId, sub), ConsistentRead: true }),
  );
  return r.Item;
}

/** One organization's members: a single-partition Query, bounded by Limit. Never a Scan. */
export async function listMemberItems(db: Db, orgId: string): Promise<Item[]> {
  const r = await db.client.send(
    new QueryCommand({
      TableName: db.coreTable,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `ORG#${orgId}`, ":prefix": "MEMBER#" },
      ConsistentRead: true,
      Limit: 100,
    }),
  );
  return r.Items ?? [];
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/** Create-if-absent. Returns false when an assignment with this id already exists. */
export async function putAssignmentIfAbsent(db: Db, item: Item): Promise<boolean> {
  try {
    await db.client.send(
      new PutCommand({
        TableName: db.coreTable,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}

export async function getAssignmentItem(db: Db, assignmentId: string): Promise<Item | undefined> {
  const r = await db.client.send(
    new GetCommand({ TableName: db.coreTable, Key: keys.assignment(assignmentId), ConsistentRead: true }),
  );
  return r.Item;
}

/** GSI1: the employee's own assignments, newest first. (GSI reads are eventually consistent.) */
export async function queryAssignmentsByEmployee(db: Db, orgId: string, employeeSub: string): Promise<Item[]> {
  const r = await db.client.send(
    new QueryCommand({
      TableName: db.coreTable,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :prefix)",
      ExpressionAttributeValues: { ":pk": keys.employeeIndex(orgId, employeeSub), ":prefix": "ASSIGN#" },
      ScanIndexForward: false,
      Limit: 50,
    }),
  );
  return r.Items ?? [];
}

/** GSI2: assignments created by this manager/admin, newest first. */
export async function queryAssignmentsByManager(db: Db, orgId: string, managerSub: string): Promise<Item[]> {
  const r = await db.client.send(
    new QueryCommand({
      TableName: db.coreTable,
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk AND begins_with(GSI2SK, :prefix)",
      ExpressionAttributeValues: { ":pk": keys.managerIndex(orgId, managerSub), ":prefix": "ASSIGN#" },
      ScanIndexForward: false,
      Limit: 50,
    }),
  );
  return r.Items ?? [];
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function getSessionItem(db: Db, sessionId: string): Promise<Item | undefined> {
  const r = await db.client.send(
    new GetCommand({ TableName: db.coreTable, Key: keys.session(sessionId), ConsistentRead: true }),
  );
  return r.Item;
}

/**
 * Start a session: create the state, append the first event, and move the
 * assignment ASSIGNED -> IN_PROGRESS, all in ONE transaction.
 *
 *  - session Put is create-if-absent: the same session cannot be created twice;
 *  - event Put is create-if-absent: a sequence number cannot be reused;
 *  - the assignment Update requires status = ASSIGNED AND the owning employee,
 *    so a concurrent or repeated start cancels the whole transaction.
 *
 * Throws TransactionCanceledException if any condition fails; the caller then
 * re-reads to decide whether this was an idempotent retry.
 */
export async function transactStartSession(
  db: Db,
  p: {
    sessionItem: Item;
    firstEventItem: Item;
    assignmentId: string;
    sessionId: string;
    employeeSub: string;
    now: string;
  },
): Promise<void> {
  await db.client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: db.coreTable,
            Item: p.sessionItem,
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: db.eventsTable,
            Item: p.firstEventItem,
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Update: {
            TableName: db.coreTable,
            Key: keys.assignment(p.assignmentId),
            UpdateExpression:
              "SET #status = :inProgress, sessionId = :sessionId, startedAt = :now, updatedAt = :now",
            ConditionExpression: "#status = :assigned AND employeeSub = :employeeSub",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":inProgress": "IN_PROGRESS",
              ":assigned": "ASSIGNED",
              ":sessionId": p.sessionId,
              ":employeeSub": p.employeeSub,
              ":now": p.now,
            },
          },
        },
      ],
    }),
  );
}

/** An additional conditional Put on the Core table that must commit atomically with an action. */
export interface CorePut {
  item: Item;
  condition: string;
  names?: Record<string, string>;
  values?: Record<string, unknown>;
}

/**
 * Apply one reducer result: replace the session state and append its event(s)
 * atomically, ONLY if the stored version is still the one the action was based
 * on. A concurrent writer therefore makes this transaction cancel (=> 409)
 * instead of silently overwriting.
 *
 *  - `employeeSub` set: the caller must still own the session (client actions).
 *    Omitted only for system-recorded results, whose authority is the engine's
 *    SYSTEM_ACTOR check plus the conditions on `extraCorePuts`.
 *  - `extraCorePuts`: a ConfigRevision (create-if-absent), a PENDING TestRun
 *    (create-if-absent) or a terminal TestRun (only if still PENDING) written in
 *    the SAME transaction, so item and state can never disagree.
 */
export async function transactApplyAction(
  db: Db,
  p: {
    nextSessionItem: Item;
    eventItems: Item[];
    expectedVersion: number;
    employeeSub?: string;
    extraCorePuts?: CorePut[];
  },
): Promise<void> {
  await db.client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: db.coreTable,
            Item: p.nextSessionItem,
            ConditionExpression:
              p.employeeSub === undefined
                ? "stateVersion = :expected"
                : "stateVersion = :expected AND employeeSub = :employeeSub",
            ExpressionAttributeValues:
              p.employeeSub === undefined
                ? { ":expected": p.expectedVersion }
                : { ":expected": p.expectedVersion, ":employeeSub": p.employeeSub },
          },
        },
        ...(p.extraCorePuts ?? []).map((x) => ({
          Put: {
            TableName: db.coreTable,
            Item: x.item,
            ConditionExpression: x.condition,
            ...(x.names ? { ExpressionAttributeNames: x.names } : {}),
            ...(x.values ? { ExpressionAttributeValues: x.values } : {}),
          },
        })),
        ...p.eventItems.map((e) => ({
          Put: {
            TableName: db.eventsTable,
            Item: e,
            ConditionExpression: "attribute_not_exists(PK)",
          },
        })),
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// Config revisions and test runs (same partition as the session)
// ---------------------------------------------------------------------------

/** Create-if-absent condition for a brand-new immutable item. */
export const CREATE_ONLY = "attribute_not_exists(PK)";
/** A PENDING run may be completed exactly once. */
export const ONLY_IF_PENDING: Pick<CorePut, "condition" | "names" | "values"> = {
  condition: "#status = :pending",
  names: { "#status": "status" },
  values: { ":pending": "PENDING" },
};

const MAX_REVISIONS_READ = 30;
const MAX_RUNS_READ = 20;

/** Saved revisions, newest first. Bounded by the engine's caps; single-partition consistent Query. */
export async function queryConfigRevisions(db: Db, sessionId: string): Promise<Item[]> {
  const r = await db.client.send(
    new QueryCommand({
      TableName: db.coreTable,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `SESSION#${sessionId}`, ":prefix": "CONFIG#" },
      ConsistentRead: true,
      ScanIndexForward: false,
      Limit: MAX_REVISIONS_READ,
    }),
  );
  return r.Items ?? [];
}

/** Test runs, newest first. */
export async function queryTestRuns(db: Db, sessionId: string): Promise<Item[]> {
  const r = await db.client.send(
    new QueryCommand({
      TableName: db.coreTable,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `SESSION#${sessionId}`, ":prefix": "TEST#" },
      ConsistentRead: true,
      ScanIndexForward: false,
      Limit: MAX_RUNS_READ,
    }),
  );
  return r.Items ?? [];
}

export async function getTestRunItem(db: Db, sessionId: string, testRunId: string): Promise<Item | undefined> {
  const r = await db.client.send(
    new GetCommand({ TableName: db.coreTable, Key: keys.testRun(sessionId, testRunId), ConsistentRead: true }),
  );
  return r.Item;
}
