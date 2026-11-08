/**
 * Persistence for the AI coworker conversation.
 *
 * Everything lives in the Core table under the session's partition, in a key namespace of its
 * own that cannot collide with STATE, CONFIG#, TEST#, IDEM#SUBMIT#, or submissions:
 *
 *   SESSION#<id> / CHAT#CTL                  control item: the exclusive turn lock and counters
 *   SESSION#<id> / CHAT#MSG#<turnId>         one turn (sortable by creation time)
 *   SESSION#<id> / CHAT#IDEM#<key>           idempotency ledger: key -> request hash + turn
 *
 * Chat is NOT scenario state. It never writes the STATE item, never changes `stateVersion` and
 * writes no Events rows, so "event sequence == state version" is untouched and the 200-action
 * cap is unaffected. (Consequence for the future: chat is not in the frozen evidence manifest.
 * A later phase can add counts and a digest of the ordered turns to NEW submissions without
 * touching existing ones.)
 *
 * Concurrency. The control item carries a revision `ctlRev`. EVERY change to it is conditional on
 * the revision the caller read, so lock acquisition, the attempt/turn counters and the new
 * PENDING turn commit atomically in one TransactWriteItems or not at all. A ConditionCheck on
 * the STATE item ties the reservation to "this session is still INVESTIGATING and still this
 * employee's" at the same instant, without writing STATE.
 */

import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { COWORKER_MAX_REPLY_CHARS, TurnIdSchema, type CoworkerTurnView, CoworkerTurnViewSchema } from "@onboardos/contracts";
import type { Db } from "./deps.js";
import { SESSION_ID_PATTERN } from "./ids.js";
import { keys } from "./records.js";

type Item = Record<string, unknown>;

/** A reservation not completed within this long is considered abandoned (SDK abort is 20 s, Lambda 29 s). */
export const LEASE_MS = 60_000;
/** Turns kept per session: 30 attempts at most, so this never truncates real data. */
const MAX_TURNS_READ = 50;

export const chatKeys = {
  control: (sessionId: string) => ({ PK: `SESSION#${sessionId}`, SK: "CHAT#CTL" as const }),
  turn: (sessionId: string, turnId: string) => ({ PK: `SESSION#${sessionId}`, SK: `CHAT#MSG#${turnId}` }),
  ledger: (sessionId: string, key: string) => ({ PK: `SESSION#${sessionId}`, SK: `CHAT#IDEM#${key}` }),
};

/** `turn_<13-digit epoch ms>_<12 hex>`: sortable by time, opaque, unique by its random part. */
export function newTurnId(nowIso: string, hex: string): string {
  return `turn_${String(Date.parse(nowIso)).padStart(13, "0")}_${hex}`;
}

// ---------------------------------------------------------------------------
// Control item
// ---------------------------------------------------------------------------

const ControlSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.literal("CHAT#CTL"),
    entityType: z.literal("COWORKER_CONTROL"),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    ctlRev: z.number().int().nonnegative(),
    ctlActive: TurnIdSchema.nullable(),
    ctlLease: z.string().nullable(),
    ctlAttempts: z.number().int().nonnegative(),
    ctlCompleted: z.number().int().nonnegative(),
    ctlUpdatedAt: z.string(),
  })
  .refine((c) => c.PK === `SESSION#${c.sessionId}`, { message: "control key does not match content" })
  // A held lock must have a lease; a free lock must not.
  .refine((c) => (c.ctlActive === null) === (c.ctlLease === null), { message: "lock and lease disagree" })
  .refine((c) => c.ctlCompleted <= c.ctlAttempts, { message: "more completed turns than attempts" });

export type ControlRecord = z.infer<typeof ControlSchema>;

export function parseControl(item: unknown): ControlRecord | null {
  const r = ControlSchema.safeParse(item);
  return r.success ? r.data : null;
}

/** What the lock looks like for a session that has never used chat. */
export const FRESH_CONTROL = (sessionId: string, now: string): ControlRecord => ({
  ...chatKeys.control(sessionId),
  entityType: "COWORKER_CONTROL",
  sessionId,
  ctlRev: 0,
  ctlActive: null,
  ctlLease: null,
  ctlAttempts: 0,
  ctlCompleted: 0,
  ctlUpdatedAt: now,
});

export const leaseExpired = (c: ControlRecord, nowIso: string): boolean =>
  c.ctlLease !== null && Date.parse(nowIso) >= Date.parse(c.ctlLease);

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

const TurnSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.string(),
    entityType: z.literal("COWORKER_TURN"),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    organizationId: z.string(),
    turnId: TurnIdSchema,
    employeeSub: z.string(),
    status: z.enum(["PENDING", "COMPLETE", "ERROR"]),
    userText: z.string().min(1).max(600),
    replyText: z.string().max(COWORKER_MAX_REPLY_CHARS).nullable(),
    isTruncated: z.boolean(),
    modelId: z.string(),
    promptVersion: z.string(),
    /** Which coaching policy built this turn's request (audit; absent on turns created before prompt v2). */
    coachingProfileId: z.string().optional(),
    coachingProfileVersion: z.number().int().positive().optional(),
    coachingProfileHash: z.string().optional(),
    coachingProfileSource: z.enum(["BUILTIN", "PLATFORM_DEFAULT", "INVALID_FALLBACK", "ORG_PUBLISHED"]).optional(),
    /** coworker-v3: the kind of bare follow-up the message was recognised as, when it was (audit only). */
    followUpKind: z.enum(["SIMPLIFY", "CLARIFY", "ELABORATE", "SHORTEN", "JUSTIFY"]).optional(),
    /** coworker-v3.1: absent or MODEL = a model produced the reply; PLATFORM_CLARIFICATION = the fixed no-referent clarification (no model call). */
    answerSource: z.enum(["MODEL", "PLATFORM_CLARIFICATION"]).optional(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    /** Audit only; never sent to the browser. */
    usageTokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).nullable(),
    providerRequestId: z.string().nullable(),
    stopReason: z.string().nullable(),
    latencyMs: z.number().nonnegative().nullable(),
  })
  .refine(
    (t) => {
      const k = chatKeys.turn(t.sessionId, t.turnId);
      if (t.PK !== k.PK || t.SK !== k.SK) return false;
      if (t.status === "PENDING") return t.replyText === null && t.completedAt === null && t.errorCode === null;
      if (t.status === "COMPLETE") return t.replyText !== null && t.replyText.length > 0 && t.completedAt !== null && t.errorCode === null;
      return t.replyText === null && t.completedAt !== null && t.errorCode !== null && t.errorMessage !== null;
    },
    { message: "turn is internally inconsistent" },
  );

export type TurnRecord = z.infer<typeof TurnSchema>;

export function parseTurn(item: unknown): TurnRecord | null {
  const r = TurnSchema.safeParse(item);
  return r.success ? r.data : null;
}

export function buildPendingTurn(input: {
  sessionId: string;
  organizationId: string;
  employeeSub: string;
  turnId: string;
  userText: string;
  modelId: string;
  promptVersion: string;
  followUpKind?: "SIMPLIFY" | "CLARIFY" | "ELABORATE" | "SHORTEN" | "JUSTIFY" | null;
  answerSource?: "MODEL" | "PLATFORM_CLARIFICATION";
  coaching?: { profileId: string; profileVersion: number; hash: string; source: "BUILTIN" | "PLATFORM_DEFAULT" | "INVALID_FALLBACK" | "ORG_PUBLISHED" };
  now: string;
}): TurnRecord {
  return {
    ...chatKeys.turn(input.sessionId, input.turnId),
    entityType: "COWORKER_TURN",
    sessionId: input.sessionId,
    organizationId: input.organizationId,
    turnId: input.turnId,
    employeeSub: input.employeeSub,
    status: "PENDING",
    userText: input.userText,
    replyText: null,
    isTruncated: false,
    modelId: input.modelId,
    promptVersion: input.promptVersion,
    ...(input.followUpKind ? { followUpKind: input.followUpKind } : {}),
    ...(input.answerSource ? { answerSource: input.answerSource } : {}),
    ...(input.coaching
      ? {
          coachingProfileId: input.coaching.profileId,
          coachingProfileVersion: input.coaching.profileVersion,
          coachingProfileHash: input.coaching.hash,
          coachingProfileSource: input.coaching.source,
        }
      : {}),
    createdAt: input.now,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    usageTokens: null,
    providerRequestId: null,
    stopReason: null,
    latencyMs: null,
  };
}

/** Client projection. Parsing through the contract strips everything not public (usage, request ids, subs). */
export function toTurnView(t: TurnRecord): CoworkerTurnView {
  return CoworkerTurnViewSchema.parse({
    turnId: t.turnId,
    status: t.status,
    userText: t.userText,
    reply: t.replyText,
    truncated: t.isTruncated,
    modelId: t.modelId,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
    errorCode: t.errorCode,
    errorMessage: t.errorMessage,
  });
}

// ---------------------------------------------------------------------------
// Idempotency ledger
// ---------------------------------------------------------------------------

const LedgerSchema = z.looseObject({
  PK: z.string(),
  SK: z.string().startsWith("CHAT#IDEM#"),
  entityType: z.literal("COWORKER_IDEMPOTENCY"),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  turnId: TurnIdSchema,
  createdAt: z.string(),
});
export type LedgerRecord = z.infer<typeof LedgerSchema>;

export function parseLedger(item: unknown): LedgerRecord | null {
  const r = LedgerSchema.safeParse(item);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------------------
// Reads (all consistent, all single-partition)
// ---------------------------------------------------------------------------

const get = async (db: Db, key: Item): Promise<Item | undefined> =>
  (await db.client.send(new GetCommand({ TableName: db.coreTable, Key: key, ConsistentRead: true }))).Item;

export const getControlItem = (db: Db, sessionId: string) => get(db, chatKeys.control(sessionId));
export const getTurnItem = (db: Db, sessionId: string, turnId: string) => get(db, chatKeys.turn(sessionId, turnId));
export const getLedgerItem = (db: Db, sessionId: string, key: string) => get(db, chatKeys.ledger(sessionId, key));

/** A session's turns, oldest first. */
export async function queryTurnItems(db: Db, sessionId: string): Promise<Item[]> {
  const r = await db.client.send(
    new QueryCommand({
      TableName: db.coreTable,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `SESSION#${sessionId}`, ":prefix": "CHAT#MSG#" },
      ConsistentRead: true,
      ScanIndexForward: true,
      Limit: MAX_TURNS_READ,
    }),
  );
  return r.Items ?? [];
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Reserve a turn: ALL of these commit together or none do.
 *   1. ConditionCheck: the session is still INVESTIGATING and still this employee's (STATE is read, not written).
 *   2. The control item moves to the new lock holder with incremented counters. Conditional on the
 *      revision just read (or, for a session's first chat, on the item not existing), which is what makes
 *      the lock exclusive: a concurrent reservation read the same revision and loses.
 *   3. If the previous holder's lease expired, that turn is closed as STRANDED (only if still PENDING).
 *   4. The new turn, PENDING, create-only.
 *   5. The idempotency ledger entry, create-only.
 */
export async function transactReserveTurn(
  db: Db,
  p: {
    sessionId: string;
    employeeSub: string;
    control: ControlRecord | null;
    nextControl: ControlRecord;
    stranded: { turnId: string; code: string; message: string } | null;
    turn: TurnRecord;
    ledger: Item;
    now: string;
  },
): Promise<void> {
  const nc = p.nextControl;
  const controlOp = p.control
    ? {
        Update: {
          TableName: db.coreTable,
          Key: chatKeys.control(p.sessionId),
          UpdateExpression:
            "SET ctlActive = :active, ctlLease = :lease, ctlAttempts = :attempts, ctlRev = :newRev, ctlUpdatedAt = :now",
          ConditionExpression: "ctlRev = :rev",
          ExpressionAttributeValues: {
            ":active": nc.ctlActive,
            ":lease": nc.ctlLease,
            ":attempts": nc.ctlAttempts,
            ":newRev": nc.ctlRev,
            ":now": p.now,
            ":rev": p.control.ctlRev,
          },
        },
      }
    : { Put: { TableName: db.coreTable, Item: nc, ConditionExpression: "attribute_not_exists(PK)" } };

  await db.client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: db.coreTable,
            Key: keys.session(p.sessionId),
            ConditionExpression: "#phase = :investigating AND employeeSub = :sub",
            ExpressionAttributeNames: { "#phase": "phase" },
            ExpressionAttributeValues: { ":investigating": "INVESTIGATING", ":sub": p.employeeSub },
          },
        },
        controlOp,
        ...(p.stranded
          ? [
              {
                Update: {
                  TableName: db.coreTable,
                  Key: chatKeys.turn(p.sessionId, p.stranded.turnId),
                  UpdateExpression: "SET #status = :error, errorCode = :code, errorMessage = :message, completedAt = :now",
                  ConditionExpression: "#status = :pending",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":error": "ERROR",
                    ":pending": "PENDING",
                    ":code": p.stranded.code,
                    ":message": p.stranded.message,
                    ":now": p.now,
                  },
                },
              },
            ]
          : []),
        { Put: { TableName: db.coreTable, Item: p.turn, ConditionExpression: "attribute_not_exists(PK)" } },
        { Put: { TableName: db.coreTable, Item: p.ledger, ConditionExpression: "attribute_not_exists(PK)" } },
      ],
    }),
  );
}

export type TurnOutcome =
  | {
      kind: "COMPLETE";
      reply: string;
      truncated: boolean;
      usage: { input: number; output: number };
      requestId: string | null;
      stopReason: string;
      latencyMs: number | null;
    }
  | { kind: "ERROR"; code: string; message: string; requestId: string | null };

/**
 * Finish a turn and release the lock it holds, atomically. Both halves are conditional: the turn
 * must still be PENDING and the lock must still belong to THIS turn at the revision read. If the
 * lease was taken over meanwhile (the turn was closed as STRANDED), this cancels and the late
 * outcome is discarded rather than overwriting the terminal record or freeing someone else's lock.
 */
export async function transactFinishTurn(
  db: Db,
  p: { sessionId: string; turnId: string; control: ControlRecord; outcome: TurnOutcome; now: string },
): Promise<void> {
  const o = p.outcome;
  const completedDelta = o.kind === "COMPLETE" ? 1 : 0;
  const turnUpdate =
    o.kind === "COMPLETE"
      ? {
          UpdateExpression:
            "SET #status = :next, replyText = :reply, isTruncated = :truncated, completedAt = :now, usageTokens = :usage, providerRequestId = :rid, stopReason = :stop, latencyMs = :latency",
          values: {
            ":next": "COMPLETE",
            ":reply": o.reply,
            ":truncated": o.truncated,
            ":usage": o.usage,
            ":rid": o.requestId,
            ":stop": o.stopReason,
            ":latency": o.latencyMs,
          },
        }
      : {
          UpdateExpression:
            "SET #status = :next, errorCode = :code, errorMessage = :message, completedAt = :now, providerRequestId = :rid",
          values: { ":next": "ERROR", ":code": o.code, ":message": o.message, ":rid": o.requestId },
        };

  await db.client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: db.coreTable,
            Key: chatKeys.turn(p.sessionId, p.turnId),
            UpdateExpression: turnUpdate.UpdateExpression,
            ConditionExpression: "#status = :pending",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ...turnUpdate.values, ":pending": "PENDING", ":now": p.now },
          },
        },
        {
          Update: {
            TableName: db.coreTable,
            Key: chatKeys.control(p.sessionId),
            UpdateExpression:
              "SET ctlActive = :none, ctlLease = :none, ctlCompleted = :completed, ctlRev = :newRev, ctlUpdatedAt = :now",
            ConditionExpression: "ctlActive = :turn AND ctlRev = :rev",
            ExpressionAttributeValues: {
              ":none": null,
              ":completed": p.control.ctlCompleted + completedDelta,
              ":newRev": p.control.ctlRev + 1,
              ":now": p.now,
              ":turn": p.turnId,
              ":rev": p.control.ctlRev,
            },
          },
        },
      ],
    }),
  );
}
