/**
 * Organization-scoped coaching configuration (milestone M1): drafts, immutable published versions, and the
 * "current version" pointer, all in the existing Core table under the organization's partition.
 *
 *   PK ORG#<org>   SK COACHDRAFT#<scenario>#v<scenarioVersion>                 the one editable draft (revisioned)
 *   PK ORG#<org>   SK COACHPUB#<scenario>#v<scenarioVersion>#<profileVersion>   an IMMUTABLE published version
 *   PK ORG#<org>   SK COACHCUR#<scenario>#v<scenarioVersion>                    pointer to the newest published version
 *
 * The prefixes cannot collide with the existing MEMBER# items of the same partition, and none of these items has
 * GSI attributes, so they appear in no index.
 *
 * Immutability: a version is written ONCE with attribute_not_exists and no code path updates or deletes it
 * (DeleteItem is not even granted to the API role). Its content hash is stored with it and re-verified on every read
 * that matters. Publishing is one TransactWriteItems that creates the version, advances the pointer with a
 * compare-and-set on the previous version, and stamps the draft only if it is still at the published revision.
 *
 * Scenario version and profile version are different dimensions: the key carries both.
 */

import { createHash } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { CoachingDraftContentSchema, type CoachingDraftContent, type ScenarioCoachingProfile } from "@onboardos/contracts";
import { ScenarioCoachingProfileSchema } from "./coachingProfile.js";
import { contentHash } from "./coworkerContext.js";
import type { Db } from "./deps.js";
import { isConditionalFailure } from "./repo.js";

type Item = Record<string, unknown>;

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

export const coachingKeys = {
  draft: (org: string, scenarioId: string, scenarioVersion: number) => ({ PK: `ORG#${org}`, SK: `COACHDRAFT#${scenarioId}#v${pad(scenarioVersion, 4)}` }),
  current: (org: string, scenarioId: string, scenarioVersion: number) => ({ PK: `ORG#${org}`, SK: `COACHCUR#${scenarioId}#v${pad(scenarioVersion, 4)}` }),
  version: (org: string, scenarioId: string, scenarioVersion: number, profileVersion: number) => ({
    PK: `ORG#${org}`,
    SK: `COACHPUB#${scenarioId}#v${pad(scenarioVersion, 4)}#${pad(profileVersion, 6)}`,
  }),
  versionPrefix: (scenarioId: string, scenarioVersion: number) => `COACHPUB#${scenarioId}#v${pad(scenarioVersion, 4)}#`,
};

/** Stable identity of an organization's coaching for one scenario; the version number is separate. */
export function profileIdFor(org: string, scenarioId: string): string {
  return `org-coaching-${createHash("sha256").update(`${org}|${scenarioId}`, "utf8").digest("hex").slice(0, 12)}`;
}

/** The full, strictly validated profile for an organization's draft content. */
export function profileFromContent(org: string, scenarioId: string, profileVersion: number, content: CoachingDraftContent): unknown {
  return { schemaVersion: 1, profileId: profileIdFor(org, scenarioId), profileVersion, ...content };
}

/** The editable fields of a profile (identity fields removed). */
export function contentFromProfile(p: ScenarioCoachingProfile): CoachingDraftContent {
  const { audience, learningObjectives, successCriteria, terminology, constraints, reference, coaching } = p;
  return CoachingDraftContentSchema.parse({ audience, learningObjectives, successCriteria, terminology, constraints, reference, coaching });
}

// -- records ---------------------------------------------------------------------------------------

const Sub = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const DraftSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.string(),
    entityType: z.literal("COACHING_DRAFT"),
    organizationId: z.string(),
    scenarioId: z.string(),
    scenarioVersion: z.number().int().positive(),
    draftRevision: z.number().int().positive(),
    content: CoachingDraftContentSchema,
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    createdAt: z.string(),
    createdBySub: Sub,
    updatedAt: z.string(),
    updatedBySub: Sub,
    publishedThroughRevision: z.number().int().nonnegative(),
    lastPublishedProfileVersion: z.number().int().nonnegative(),
  })
  .refine(
    (r) => {
      const k = coachingKeys.draft(r.organizationId, r.scenarioId, r.scenarioVersion);
      return r.PK === k.PK && r.SK === k.SK && r.contentHash === contentHash(r.content);
    },
    { message: "coaching draft keys or hash do not match content" },
  );
export type DraftRecord = z.infer<typeof DraftSchema>;
export const parseDraft = (item: unknown): DraftRecord | null => {
  const r = DraftSchema.safeParse(item);
  return r.success ? r.data : null;
};

const VersionSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.string(),
    entityType: z.literal("COACHING_PROFILE_VERSION"),
    organizationId: z.string(),
    scenarioId: z.string(),
    scenarioVersion: z.number().int().positive(),
    profileId: z.string(),
    profileVersion: z.number().int().positive(),
    status: z.literal("PUBLISHED"),
    profile: ScenarioCoachingProfileSchema,
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    publishedAt: z.string(),
    publishedBySub: Sub,
    sourceDraftRevision: z.number().int().positive(),
  })
  .refine(
    (r) => {
      const k = coachingKeys.version(r.organizationId, r.scenarioId, r.scenarioVersion, r.profileVersion);
      return r.PK === k.PK && r.SK === k.SK && r.profile.profileId === r.profileId && r.profile.profileVersion === r.profileVersion;
    },
    { message: "coaching version keys or identity do not match content" },
  );
export type VersionRecord = z.infer<typeof VersionSchema>;
/** Shape check only. Callers that USE a version must also verify the content hash (see verifyVersion). */
export const parseVersion = (item: unknown): VersionRecord | null => {
  const r = VersionSchema.safeParse(item);
  return r.success ? r.data : null;
};

const PointerSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.string(),
    entityType: z.literal("COACHING_CURRENT"),
    organizationId: z.string(),
    scenarioId: z.string(),
    scenarioVersion: z.number().int().positive(),
    currentProfileVersion: z.number().int().positive(),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    updatedAt: z.string(),
    updatedBySub: Sub,
  })
  .refine(
    (r) => {
      const k = coachingKeys.current(r.organizationId, r.scenarioId, r.scenarioVersion);
      return r.PK === k.PK && r.SK === k.SK;
    },
    { message: "coaching pointer keys do not match content" },
  );
export type PointerRecord = z.infer<typeof PointerSchema>;
export const parsePointer = (item: unknown): PointerRecord | null => {
  const r = PointerSchema.safeParse(item);
  return r.success ? r.data : null;
};

/** Why a stored version was refused for use. Fixed vocabulary: safe to log, never contains profile text. */
export type VersionFault = "MISSING" | "CORRUPT" | "ORG_MISMATCH" | "SCENARIO_MISMATCH" | "IDENTITY_MISMATCH" | "HASH_MISMATCH";

/**
 * Accept a stored version for USE only if it is exactly what was asked for: well-formed, in this organization, for this
 * scenario version, with the expected profile identity and version, and with content that still hashes to the hash
 * stored with it (and, when given, to the hash an assignment recorded).
 */
export function verifyVersion(
  item: unknown,
  want: { organizationId: string; scenarioId: string; scenarioVersion: number; profileVersion: number; profileId?: string; contentHash?: string },
): { ok: true; record: VersionRecord } | { ok: false; fault: VersionFault } {
  if (!item) return { ok: false, fault: "MISSING" };
  const rec = parseVersion(item);
  if (!rec) return { ok: false, fault: "CORRUPT" };
  if (rec.organizationId !== want.organizationId) return { ok: false, fault: "ORG_MISMATCH" };
  if (rec.scenarioId !== want.scenarioId || rec.scenarioVersion !== want.scenarioVersion) return { ok: false, fault: "SCENARIO_MISMATCH" };
  if (rec.profileVersion !== want.profileVersion || (want.profileId !== undefined && rec.profileId !== want.profileId)) return { ok: false, fault: "IDENTITY_MISMATCH" };
  const actual = contentHash(rec.profile);
  if (actual !== rec.contentHash || (want.contentHash !== undefined && actual !== want.contentHash)) return { ok: false, fault: "HASH_MISMATCH" };
  return { ok: true, record: rec };
}

// -- reads -------------------------------------------------------------------------------------------

const get = async (db: Db, key: { PK: string; SK: string }): Promise<Item | undefined> =>
  (await db.client.send(new GetCommand({ TableName: db.coreTable, Key: key, ConsistentRead: true }))).Item;

export const getDraftItem = (db: Db, org: string, sid: string, sv: number) => get(db, coachingKeys.draft(org, sid, sv));
export const getPointerItem = (db: Db, org: string, sid: string, sv: number) => get(db, coachingKeys.current(org, sid, sv));
export const getVersionItem = (db: Db, org: string, sid: string, sv: number, pv: number) => get(db, coachingKeys.version(org, sid, sv, pv));

const MAX_VERSIONS_LISTED = 50;

/** Newest first, bounded. One partition, one prefix: never a Scan. */
export async function queryVersionItems(db: Db, org: string, sid: string, sv: number): Promise<Item[]> {
  const r = await db.client.send(
    new QueryCommand({
      TableName: db.coreTable,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `ORG#${org}`, ":prefix": coachingKeys.versionPrefix(sid, sv) },
      ConsistentRead: true,
      ScanIndexForward: false,
      Limit: MAX_VERSIONS_LISTED,
    }),
  );
  return r.Items ?? [];
}

// -- draft writes (single-item, conditional) --------------------------------------------------------------

export function newDraftItem(p: { org: string; scenarioId: string; scenarioVersion: number; content: CoachingDraftContent; actorSub: string; now: string }): Item {
  return {
    ...coachingKeys.draft(p.org, p.scenarioId, p.scenarioVersion),
    entityType: "COACHING_DRAFT",
    organizationId: p.org,
    scenarioId: p.scenarioId,
    scenarioVersion: p.scenarioVersion,
    draftRevision: 1,
    content: p.content,
    contentHash: contentHash(p.content),
    createdAt: p.now,
    createdBySub: p.actorSub,
    updatedAt: p.now,
    updatedBySub: p.actorSub,
    publishedThroughRevision: 0,
    lastPublishedProfileVersion: 0,
  };
}

/** Create the first draft. false => a draft already exists (someone else created it first). */
export async function createDraftIfAbsent(db: Db, item: Item): Promise<boolean> {
  try {
    await db.client.send(new PutCommand({ TableName: db.coreTable, Item: item, ConditionExpression: "attribute_not_exists(PK)" }));
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}

/** Replace the draft content ONLY if its revision is still `expectedRevision`. false => someone else saved first. */
export async function updateDraftIfRevision(
  db: Db,
  p: { org: string; scenarioId: string; scenarioVersion: number; expectedRevision: number; content: CoachingDraftContent; actorSub: string; now: string },
): Promise<boolean> {
  try {
    await db.client.send(
      new UpdateCommand({
        TableName: db.coreTable,
        Key: coachingKeys.draft(p.org, p.scenarioId, p.scenarioVersion),
        UpdateExpression: "SET #c = :c, contentHash = :h, draftRevision = :next, updatedAt = :t, updatedBySub = :s",
        ConditionExpression: "draftRevision = :exp",
        ExpressionAttributeNames: { "#c": "content" },
        ExpressionAttributeValues: {
          ":c": p.content,
          ":h": contentHash(p.content),
          ":next": p.expectedRevision + 1,
          ":t": p.now,
          ":s": p.actorSub,
          ":exp": p.expectedRevision,
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}

// -- publish (one transaction) ---------------------------------------------------------------------------------

export function newVersionItem(p: {
  org: string; scenarioId: string; scenarioVersion: number; profile: ScenarioCoachingProfile; sourceDraftRevision: number; actorSub: string; now: string;
}): Item {
  return {
    ...coachingKeys.version(p.org, p.scenarioId, p.scenarioVersion, p.profile.profileVersion),
    entityType: "COACHING_PROFILE_VERSION",
    organizationId: p.org,
    scenarioId: p.scenarioId,
    scenarioVersion: p.scenarioVersion,
    profileId: p.profile.profileId,
    profileVersion: p.profile.profileVersion,
    status: "PUBLISHED",
    profile: p.profile,
    contentHash: contentHash(p.profile),
    publishedAt: p.now,
    publishedBySub: p.actorSub,
    sourceDraftRevision: p.sourceDraftRevision,
  };
}

/**
 * Publish: create the version (create-if-absent), advance the pointer by compare-and-set on the previous version
 * (or create it if this is the first), and stamp the draft only if it is still at the published revision.
 * All or nothing. Throws TransactionCanceledException when any condition fails; the caller re-reads to classify.
 */
export async function transactPublish(
  db: Db,
  p: { org: string; scenarioId: string; scenarioVersion: number; version: Item; previousVersion: number; draftRevision: number; actorSub: string; now: string },
): Promise<void> {
  const pv = p.version["profileVersion"] as number;
  const hash = p.version["contentHash"] as string;
  const pointerKey = coachingKeys.current(p.org, p.scenarioId, p.scenarioVersion);
  await db.client.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: db.coreTable, Item: p.version, ConditionExpression: "attribute_not_exists(PK)" } },
        p.previousVersion === 0
          ? {
              Put: {
                TableName: db.coreTable,
                Item: {
                  ...pointerKey,
                  entityType: "COACHING_CURRENT",
                  organizationId: p.org,
                  scenarioId: p.scenarioId,
                  scenarioVersion: p.scenarioVersion,
                  currentProfileVersion: pv,
                  contentHash: hash,
                  updatedAt: p.now,
                  updatedBySub: p.actorSub,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            }
          : {
              Update: {
                TableName: db.coreTable,
                Key: pointerKey,
                UpdateExpression: "SET currentProfileVersion = :pv, contentHash = :h, updatedAt = :t, updatedBySub = :s",
                ConditionExpression: "currentProfileVersion = :prev",
                ExpressionAttributeValues: { ":pv": pv, ":h": hash, ":t": p.now, ":s": p.actorSub, ":prev": p.previousVersion },
              },
            },
        {
          Update: {
            TableName: db.coreTable,
            Key: coachingKeys.draft(p.org, p.scenarioId, p.scenarioVersion),
            UpdateExpression: "SET publishedThroughRevision = :rev, lastPublishedProfileVersion = :pv",
            ConditionExpression: "draftRevision = :rev",
            ExpressionAttributeValues: { ":rev": p.draftRevision, ":pv": pv },
          },
        },
      ],
    }),
  );
}
