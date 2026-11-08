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

/**
 * Apply one reducer result: replace the session state and append its event
 * atomically, ONLY if the stored version is still the one the action was based
 * on and the caller still owns the session. A concurrent writer therefore makes
 * this transaction cancel (=> 409) instead of silently overwriting.
 */
export async function transactApplyAction(
  db: Db,
  p: { nextSessionItem: Item; eventItems: Item[]; expectedVersion: number; employeeSub: string },
): Promise<void> {
  await db.client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: db.coreTable,
            Item: p.nextSessionItem,
            ConditionExpression: "stateVersion = :expected AND employeeSub = :employeeSub",
            ExpressionAttributeValues: { ":expected": p.expectedVersion, ":employeeSub": p.employeeSub },
          },
        },
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
