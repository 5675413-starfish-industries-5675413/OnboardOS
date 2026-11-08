/**
 * Correctness of the exact DynamoDB operations behind the Coaching Studio, checked against what the REAL service requires.
 *
 * Honest scope: the in-memory fake implements the conditional semantics the code relies on, and these tests inspect the
 * commands the code sends. Neither is a substitute for running against a real table, which has NOT been done. Where the
 * real service differs from the fake (reserved words, one-action-per-item in a transaction, cancellation reasons, IAM per
 * item action), the differences are checked explicitly here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachingDraftContent } from "@onboardos/contracts";
import { ScenarioCoachingProfileSchema } from "../coachingProfile.js";
import { coachingKeys, newVersionItem, profileFromContent } from "../coachingStore.js";
import { CORE, ORG, PEOPLE, R, askCoworker, createApi, startedFor, type Api, type Person } from "./harness.js";
import { DYNAMODB_RESERVED_WORDS } from "./dynamoReserved.js";

let api: Api;
const SC = "inc-104";
const P = { orgId: ORG, scenarioId: SC };

type Sent = { command: string; input: Record<string, any> };
let sent: Sent[] = [];
/** Record every command the code sends (without failing any). */
function capture(): void {
  sent = [];
  api.db.fail = (command, input) => { sent.push({ command, input: input as Record<string, any> }); return null; };
}

const studio = (who: Person = PEOPLE.mgrA) => api.call({ route: R.coachStudio, as: who, params: P });
const save = (who: Person, expectedRevision: number, content: unknown) => api.call({ route: R.coachSave, as: who, params: P, body: { expectedRevision, content } });
const publish = (who: Person, draftRevision: number, expectedCurrentVersion: number) => api.call({ route: R.coachPublish, as: who, params: P, body: { draftRevision, expectedCurrentVersion } });
const content = async (marker: string): Promise<CoachingDraftContent> => {
  const t: CoachingDraftContent = (await studio()).body.template;
  return { ...t, learningObjectives: [`Objective ${marker}`, ...t.learningObjectives.slice(1, 3)] };
};
const versionItem = (pv: number) => api.db.get(CORE, coachingKeys.version(ORG, SC, 1, pv));
const pointerItem = () => api.db.get(CORE, coachingKeys.current(ORG, SC, 1));
const draftItem = () => api.db.get(CORE, coachingKeys.draft(ORG, SC, 1));
const items = () => api.db.all(CORE).filter((i) => i["PK"] === `ORG#${ORG}` && /^COACH/.test(String(i["SK"])));
const transacts = () => sent.filter((s) => s.command === "TransactWrite");
const keyOf = (t: any) => JSON.stringify((t.Put ?? t.Update ?? t.Delete ?? t.ConditionCheck).Key ?? (t.Put?.Item && { PK: t.Put.Item.PK, SK: t.Put.Item.SK }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  api = createApi();
});

// -- the commands ---------------------------------------------------------------------------------------------------

describe("the exact operations", () => {
  it("first-ever draft creation is one conditional Put (create only if absent)", async () => {
    capture();
    await save(PEOPLE.mgrA, 0, await content("A"));
    const puts = sent.filter((s) => s.command === "Put" && s.input["Item"]?.["entityType"] === "COACHING_DRAFT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.input["ConditionExpression"]).toBe("attribute_not_exists(PK)");
    expect(sent.filter((s) => s.command === "TransactWrite")).toHaveLength(0);
  });

  it("updating a draft is one conditional Update on the expected revision (no read-modify-write window)", async () => {
    await save(PEOPLE.mgrA, 0, await content("A"));
    capture();
    await save(PEOPLE.mgrA, 1, await content("B"));
    const upd = sent.filter((s) => s.command === "Update");
    expect(upd).toHaveLength(1);
    expect(upd[0]!.input["ConditionExpression"]).toBe("draftRevision = :exp");
    expect(upd[0]!.input["ExpressionAttributeValues"][":exp"]).toBe(1);
    expect(upd[0]!.input["ExpressionAttributeValues"][":next"]).toBe(2);
  });

  it("first publication: version Put, pointer Put (both create-only) and a conditional draft Update; three DISTINCT items", async () => {
    await save(PEOPLE.mgrA, 0, await content("A"));
    capture();
    expect((await publish(PEOPLE.mgrA, 1, 0)).status).toBe(201);
    const [tx] = transacts();
    const t = tx!.input["TransactItems"] as any[];
    expect(t).toHaveLength(3);
    expect(t.map(keyOf)).toEqual([...new Set(t.map(keyOf))]); // distinct
    expect(t[0].Put.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(t[0].Put.Item.SK).toMatch(/^COACHPUB#inc-104#v0001#000001$/);
    expect(t[1].Put.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(t[1].Put.Item.SK).toBe(coachingKeys.current(ORG, SC, 1).SK);
    expect(t[2].Update.ConditionExpression).toBe("draftRevision = :rev");
    expect(t[2].Update.Key).toEqual(coachingKeys.draft(ORG, SC, 1));
  });

  it("later publication: version Put, pointer compare-and-set on the previous version, conditional draft Update", async () => {
    await save(PEOPLE.mgrA, 0, await content("A"));
    await publish(PEOPLE.mgrA, 1, 0);
    await save(PEOPLE.mgrA, 1, await content("B"));
    capture();
    expect((await publish(PEOPLE.mgrA, 2, 1)).status).toBe(201);
    const t = transacts()[0]!.input["TransactItems"] as any[];
    expect(t[0].Put.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(t[0].Put.Item.SK).toMatch(/#000002$/);
    expect(t[1].Update.ConditionExpression).toBe("currentProfileVersion = :prev");
    expect(t[1].Update.ExpressionAttributeValues[":prev"]).toBe(1);
    expect(t[2].Update.ConditionExpression).toBe("draftRevision = :rev");
    expect(new Set(t.map(keyOf)).size).toBe(3);
  });

  it("every transaction action carries a condition, uses no ConditionCheck (not granted by IAM), and targets the Core table", async () => {
    await save(PEOPLE.mgrA, 0, await content("A"));
    capture();
    await publish(PEOPLE.mgrA, 1, 0);
    for (const a of transacts()[0]!.input["TransactItems"] as any[]) {
      expect(Object.keys(a)).toHaveLength(1);
      expect(a.ConditionCheck).toBeUndefined();
      expect(a.Delete).toBeUndefined();
      const body = a.Put ?? a.Update;
      expect(body.TableName).toBe(CORE);
      expect(body.ConditionExpression).toBeTruthy();
    }
  });

  it("every placeholder an expression uses is supplied, and none is supplied but unused (the real service rejects both)", async () => {
    await save(PEOPLE.mgrA, 0, await content("A"));
    capture();
    await save(PEOPLE.mgrA, 1, await content("B"));
    await publish(PEOPLE.mgrA, 2, 0);
    const exprs: Array<{ text: string; values: string[]; names: string[] }> = [];
    for (const s of sent) {
      const bodies = s.command === "TransactWrite" ? (s.input["TransactItems"] as any[]).map((a) => a.Put ?? a.Update) : [s.input];
      for (const b of bodies) {
        const text = `${b.ConditionExpression ?? ""} ${b.UpdateExpression ?? ""}`;
        if (text.trim()) exprs.push({ text, values: Object.keys(b.ExpressionAttributeValues ?? {}), names: Object.keys(b.ExpressionAttributeNames ?? {}) });
      }
    }
    expect(exprs.length).toBeGreaterThan(3);
    for (const e of exprs) {
      const used = [...new Set(e.text.match(/:[A-Za-z0-9_]+/g) ?? [])];
      expect(used.sort(), e.text).toEqual([...e.values].sort());
      const usedNames = [...new Set(e.text.match(/#[A-Za-z0-9_]+/g) ?? [])];
      expect(usedNames.sort(), e.text).toEqual([...e.names].sort());
    }
  });

  it("no expression uses a DynamoDB reserved word as a bare attribute name", () => {
    const src = readFileSync(join(__dirname, "..", "coachingStore.ts"), "utf8");
    const literals = [...src.matchAll(/(?:UpdateExpression|ConditionExpression|KeyConditionExpression):\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(literals.length).toBeGreaterThanOrEqual(6);
    const FUNCTIONS = new Set(["attribute_not_exists", "attribute_exists", "begins_with", "set", "and"]);
    const bare: string[] = [];
    for (const lit of literals) for (const tok of lit.match(/(?<![:#\w])[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (!FUNCTIONS.has(tok.toLowerCase())) bare.push(tok);
    expect(bare.length).toBeGreaterThan(5);
    for (const name of new Set(bare)) expect(DYNAMODB_RESERVED_WORDS.has(name.toLowerCase()), `${name} is a DynamoDB reserved word`).toBe(false);
  });

  it("the reserved-word check can fail: it knows the words that bit this codebase before", () => {
    for (const w of ["status", "name", "hash", "key", "token", "timestamp", "user", "type"]) expect(DYNAMODB_RESERVED_WORDS.has(w)).toBe(true);
    expect(DYNAMODB_RESERVED_WORDS.has("currentprofileversion")).toBe(false);
  });
});

// -- reads -------------------------------------------------------------------------------------------------------

describe("read consistency policy", () => {
  it("every Get and Query the studio, publish and assignment pinning use is a strongly consistent read of the table (never a GSI)", async () => {
    await save(PEOPLE.mgrA, 0, await content("A"));
    await publish(PEOPLE.mgrA, 1, 0);
    capture();
    await studio();
    await api.call({ route: R.coachScenarios, as: PEOPLE.mgrA, params: { orgId: ORG } });
    await api.call({ route: R.coachVersion, as: PEOPLE.mgrA, params: { ...P, profileVersion: "1" } });
    await save(PEOPLE.mgrA, 1, await content("B"));
    await publish(PEOPLE.mgrA, 2, 1);
    await api.call({ route: R.create, as: PEOPLE.mgrA, params: { orgId: ORG }, body: { scenarioId: SC, employeeSub: PEOPLE.empA.sub } });
    const reads = sent.filter((s) => s.command === "Get" || s.command === "Query");
    expect(reads.length).toBeGreaterThan(10);
    for (const r of reads) {
      expect(r.input["IndexName"], JSON.stringify(r.input["Key"] ?? r.input["KeyConditionExpression"])).toBeUndefined();
      expect(r.input["ConsistentRead"], JSON.stringify(r.input["Key"] ?? r.input["ExpressionAttributeValues"])).toBe(true);
    }
  });
});

describe("each kind of coaching read sets ConsistentRead: true (asserted on the actual command parameters)", () => {
  /** The coaching read a captured command is, judged by what it asks for. */
  const kind = (r: Sent): string | null => {
    if (r.command === "Get") {
      const sk = String(r.input["Key"]?.["SK"] ?? "");
      return sk.startsWith("COACHDRAFT#") ? "draft Get" : sk.startsWith("COACHCUR#") ? "pointer Get" : sk.startsWith("COACHPUB#") ? "version Get" : null;
    }
    if (r.command === "Query") return String(r.input["ExpressionAttributeValues"]?.[":prefix"] ?? "").startsWith("COACHPUB#") ? "version Query" : null;
    return null;
  };

  it("draft, pointer and version Gets and the version-history Query, across the studio, publish, assignment pinning and the coworker", async () => {
    await save(PEOPLE.mgrA, 0, await content("A"));
    await publish(PEOPLE.mgrA, 1, 0);
    await api.call({ route: R.create, as: PEOPLE.mgrA, params: { orgId: ORG }, body: { scenarioId: SC, employeeSub: PEOPLE.empA.sub } });
    const started = await startedFor(api, PEOPLE.empA); // replay of the assignment above
    capture();
    await studio(); // draft Get, pointer Get, version Query
    await api.call({ route: R.coachScenarios, as: PEOPLE.mgrA, params: { orgId: ORG } });
    await api.call({ route: R.coachVersion, as: PEOPLE.mgrA, params: { ...P, profileVersion: "1" } }); // version Get
    await save(PEOPLE.mgrA, 1, await content("B"));
    await publish(PEOPLE.mgrA, 2, 1);
    await askCoworker(api, PEOPLE.empA, started.sessionId, "q"); // runtime version Get for the pinned assignment
    const seen = new Map<string, number>();
    for (const r of sent) {
      const k = kind(r);
      if (!k) continue;
      seen.set(k, (seen.get(k) ?? 0) + 1);
      expect(r.input["ConsistentRead"], `${k}: ${JSON.stringify(r.input["Key"] ?? r.input["ExpressionAttributeValues"])}`).toBe(true);
      expect(r.input["IndexName"], k).toBeUndefined();
    }
    // The assertion above is only meaningful if every kind was really exercised.
    for (const k of ["draft Get", "pointer Get", "version Get", "version Query"]) expect(seen.get(k) ?? 0, k).toBeGreaterThan(0);
  });

  it("the helper that classifies reads really distinguishes a missing flag (so the assertion can fail)", () => {
    const get = { command: "Get", input: { Key: { PK: "ORG#x", SK: "COACHDRAFT#inc-104#v0001" } } } as Sent;
    expect(kind(get)).toBe("draft Get");
    expect(get.input["ConsistentRead"]).not.toBe(true);
    expect(kind({ command: "Query", input: { ExpressionAttributeValues: { ":prefix": "COACHPUB#inc-104#v0001#" } } } as Sent)).toBe("version Query");
    expect(kind({ command: "Query", input: { ExpressionAttributeValues: { ":prefix": "MEMBER#" } } } as Sent)).toBeNull();
  });
});

// -- cancellation ---------------------------------------------------------------------------------------------------

function cancelWith(codes: string[]) {
  return (cmd: string) => {
    if (cmd !== "TransactWrite") return null;
    const e: Error & { CancellationReasons?: Array<{ Code: string }> } = new Error("Transaction cancelled");
    e.name = "TransactionCanceledException";
    e.CancellationReasons = codes.map((Code) => ({ Code }));
    return e;
  };
}

describe("cancellation reasons map to the right API errors, and a cancelled transaction writes nothing", () => {
  beforeEach(async () => { await save(PEOPLE.mgrA, 0, await content("A")); });
  const noWrites = (before: string) => expect(JSON.stringify(items())).toBe(before);

  it("a transaction conflict is a retryable 409, not a misleading edit conflict", async () => {
    const before = JSON.stringify(items());
    api.db.fail = cancelWith(["None", "TransactionConflict", "None"]);
    const r = await publish(PEOPLE.mgrA, 1, 0);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("TRY_AGAIN");
    noWrites(before);
  });

  it("throttling is a 503 'busy', not a conflict", async () => {
    const before = JSON.stringify(items());
    for (const code of ["ThrottlingError", "ProvisionedThroughputExceeded"]) {
      api.db.fail = cancelWith(["None", code, "None"]);
      const r = await publish(PEOPLE.mgrA, 1, 0);
      expect(r.status, code).toBe(503);
      expect(r.body.code).toBe("BUSY");
    }
    noWrites(before);
  });

  it("a validation or size failure is our bug: a generic 500 with nothing written", async () => {
    const before = JSON.stringify(items());
    api.db.fail = cancelWith(["ValidationError", "None", "None"]);
    expect((await publish(PEOPLE.mgrA, 1, 0)).status).toBe(500);
    noWrites(before);
  });

  it("a failed pointer condition is VERSION_CONFLICT; a failed draft condition is REVISION_CONFLICT", async () => {
    // pointer moved by someone else
    api.db.beforeTransact = () => {
      api.db.beforeTransact = null;
      api.db.put(CORE, { ...coachingKeys.current(ORG, SC, 1), entityType: "COACHING_CURRENT", organizationId: ORG, scenarioId: SC, scenarioVersion: 1, currentProfileVersion: 1, contentHash: `sha256:${"a".repeat(64)}`, updatedAt: "x", updatedBySub: "s" });
    };
    expect((await publish(PEOPLE.mgrA, 1, 0)).body.code).toBe("VERSION_CONFLICT");
    // draft edited by someone else
    api = createApi();
    await save(PEOPLE.mgrA, 0, await content("A"));
    api.db.beforeTransact = () => { api.db.beforeTransact = null; api.db.put(CORE, { ...draftItem()!, draftRevision: 2 }); };
    expect((await publish(PEOPLE.mgrA, 1, 0)).body.code).toBe("REVISION_CONFLICT");
    expect(versionItem(1)).toBeUndefined();
  });

  it("an ambiguous failure (the response was lost but the write landed) is recovered by an identical retry", async () => {
    const real = api.db.fail;
    expect(real).toBeNull();
    expect((await publish(PEOPLE.mgrA, 1, 0)).status).toBe(201);
    const retry = await publish(PEOPLE.mgrA, 1, 0);
    expect(retry.status).toBe(200);
    expect(retry.body.created).toBe(false);
    expect(items().filter((i) => String(i["SK"]).startsWith("COACHPUB#"))).toHaveLength(1);
  });
});

// -- inconsistent stored state -------------------------------------------------------------------------------------------

describe("invalid or missing current-version pointer: fail closed, never overwrite", () => {
  async function publishedOnce() {
    await save(PEOPLE.mgrA, 0, await content("ONE"));
    await publish(PEOPLE.mgrA, 1, 0);
    await save(PEOPLE.mgrA, 1, await content("TWO"));
  }

  it("a pointer that is missing while version 1 exists: publishing refuses (500) and version 1 is untouched", async () => {
    await save(PEOPLE.mgrA, 0, await content("ONE"));
    const profile = ScenarioCoachingProfileSchema.parse(profileFromContent(ORG, SC, 1, await content("EXISTING")));
    api.db.put(CORE, newVersionItem({ org: ORG, scenarioId: SC, scenarioVersion: 1, profile, sourceDraftRevision: 1, actorSub: "someone", now: "2026-11-08T00:00:00.000Z" }));
    const before = JSON.stringify(versionItem(1));
    const r = await publish(PEOPLE.mgrA, 1, 0);
    expect(r.status).toBe(500);
    expect(JSON.stringify(versionItem(1))).toBe(before);
    expect(pointerItem()).toBeUndefined();
    expect(draftItem()).toMatchObject({ publishedThroughRevision: 0 });
  });

  it("a pointer whose target version is corrupt: publishing refuses and creates nothing", async () => {
    await publishedOnce();
    api.db.put(CORE, { ...versionItem(1)!, contentHash: `sha256:${"0".repeat(64)}` });
    const r = await publish(PEOPLE.mgrA, 2, 1);
    expect(r.status).toBe(500);
    expect(versionItem(2)).toBeUndefined();
    expect(pointerItem()).toMatchObject({ currentProfileVersion: 1 });
  });

  it("a malformed pointer: every coaching read and publish fails closed (500) rather than treating it as 'no version'", async () => {
    await publishedOnce();
    api.db.put(CORE, { ...pointerItem()!, currentProfileVersion: "x" });
    expect((await studio()).status).toBe(500);
    expect((await publish(PEOPLE.mgrA, 2, 1)).status).toBe(500);
    expect((await publish(PEOPLE.mgrA, 2, 0)).status).toBe(500);
    expect(versionItem(2)).toBeUndefined();
  });

  it("the diagnostic names the reason without profile text", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => { logs.push(a.join(" ")); });
    await publishedOnce();
    api.db.put(CORE, { ...versionItem(1)!, contentHash: `sha256:${"0".repeat(64)}` });
    await publish(PEOPLE.mgrA, 2, 1);
    const line = logs.find((l) => l.includes("COACHING_STATE_INCONSISTENT"))!;
    expect(line).toContain("POINTER_TARGET_UNUSABLE");
    expect(line).not.toContain("Objective");
  });
});

// -- nothing published is overwritten, nothing confidential is public --------------------------------------------------------

describe("immutability and exposure", () => {
  it("no code path writes a published version twice: all writes to COACHPUB items are create-only", () => {
    const src = readFileSync(join(__dirname, "..", "coachingStore.ts"), "utf8");
    const writes = [...src.matchAll(/new (?:PutCommand|UpdateCommand|TransactWriteCommand)\(/g)];
    expect(writes.length).toBe(3); // draft create, draft update, publish transaction: nothing else writes
    expect(src).not.toMatch(/DeleteCommand|BatchWrite/);
    // the only version write is the create-only Put inside the transaction
    expect(src.match(/COACHPUB/g)!.length).toBeGreaterThan(0);
    expect(src.match(/Put:\s*\{\s*TableName: db\.coreTable,\s*Item: p\.version,\s*ConditionExpression: "attribute_not_exists\(PK\)"/g)).toHaveLength(1);
  });

  it("responses carry no keys, entity types, actor identities or other internals", async () => {
    await save(PEOPLE.mgrA, 0, await content("A"));
    const pub = await publish(PEOPLE.mgrA, 1, 0);
    const bodies = [JSON.stringify((await studio()).body), pub.raw, JSON.stringify((await api.call({ route: R.coachVersion, as: PEOPLE.mgrA, params: { ...P, profileVersion: "1" } })).body)];
    for (const b of bodies) {
      for (const leak of ["\"PK\"", "\"SK\"", "entityType", "publishedBySub", "createdBySub", "updatedBySub", PEOPLE.mgrA.sub, "ORG#", "COACH", "organizationId"]) expect(b, leak).not.toContain(leak);
    }
  });
});
