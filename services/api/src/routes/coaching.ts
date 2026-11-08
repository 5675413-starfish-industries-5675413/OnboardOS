/**
 * Manager Coaching Studio (milestone M1):
 *   GET  /v1/orgs/{orgId}/scenarios                                                  supported scenarios + coaching status
 *   GET  /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching                            draft, template, published versions
 *   PUT  /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/draft                      save the draft (optimistic revision)
 *   POST /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/validate                   validate + describe, persists nothing
 *   POST /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/publish                    publish an immutable version
 *   GET  /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/versions/{profileVersion}  inspect one published version
 *
 * Authorization is the existing model: the verified subject + an ACTIVE membership in the URL's organization with the
 * manager or org_admin role (requireOrgRole). Employees get 403, non-members and other organizations get an opaque 404.
 * The organization, the scenario version, the profile identity and the version number all come from the server; the
 * body only carries the editable content and the revisions the editor was looking at.
 *
 * Coaching is PUBLIC, employee-facing configuration. These routes never read or write assessment data, never touch
 * the scenario definition or the hidden evaluator, call no model, and write nothing but the coaching items.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { ZodIssue } from "zod";
import {
  CoachingStudioResponseSchema,
  CoachingVersionDetailSchema,
  ListCoachingScenariosResponseSchema,
  PublishCoachingRequestSchema,
  PublishCoachingResponseSchema,
  SaveCoachingDraftRequestSchema,
  SaveCoachingDraftResponseSchema,
  ValidateCoachingRequestSchema,
  ValidateCoachingResponseSchema,
  ScenarioIdSchema,
  type CoachingDraftContent,
  type CoachingVersionSummary,
  type ScenarioCoachingProfile,
} from "@onboardos/contracts";
import { PUBLISHED_SCENARIOS, getBuiltinCoachingProfile, getLatestPublished } from "@onboardos/scenario-fixtures";
import { requireOrgRole, NOT_FOUND } from "../authz.js";
import {
  contentFromProfile,
  createDraftIfAbsent,
  getDraftItem,
  getPointerItem,
  getVersionItem,
  newDraftItem,
  newVersionItem,
  parseDraft,
  parsePointer,
  parseVersion,
  profileFromContent,
  queryVersionItems,
  transactPublish,
  updateDraftIfRevision,
  verifyVersion,
  type DraftRecord,
  type VersionRecord,
} from "../coachingStore.js";
import { DEFAULT_COACHING_PROFILE, ScenarioCoachingProfileSchema } from "../coachingProfile.js";
import { contentHash, describeCoachingBehaviour } from "../coworkerContext.js";
import type { ApiDeps } from "../deps.js";
import { HttpError, json, parseBody, pathParam, type HttpResult } from "../http.js";
import { cancellationCodes, isTransactionCanceled } from "../repo.js";
import { INTERNAL } from "./sessions.js";

const MAX_COACHING_BODY_BYTES = 32 * 1024;
const MANAGERS = ["manager", "org_admin"] as const;

export const VALIDATION_NOTICE =
  "This shows the instructions the AI coworker will receive. No AI model was called, and nothing here tests how a model will behave.";

const SECRET_SHAPES = /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|-----BEGIN [A-Z ]*KEY-----|aws_secret_access_key/i;
const SECRET_MESSAGE = "Looks like a credential or token. Coaching text is employee-visible; remove it.";

// -- helpers ------------------------------------------------------------------------------------------

function scenarioOr404(event: APIGatewayProxyEventV2) {
  const id = pathParam(event, "scenarioId") ?? "";
  if (!ScenarioIdSchema.safeParse(id).success) throw NOT_FOUND();
  const scenario = getLatestPublished(id);
  if (!scenario) throw NOT_FOUND();
  return scenario;
}

function friendly(issue: ZodIssue): string {
  const i = issue as ZodIssue & { origin?: string; minimum?: number | bigint; maximum?: number | bigint };
  switch (i.code) {
    case "too_small":
      return i.origin === "string" && Number(i.minimum) === 1 ? "Required" : `Must be at least ${String(i.minimum)}${i.origin === "string" ? " characters" : i.origin === "array" ? " items" : ""}`;
    case "too_big":
      return `Must be at most ${String(i.maximum)}${i.origin === "string" ? " characters" : i.origin === "array" ? " items" : ""}`;
    case "invalid_value":
      return "Choose one of the listed options";
    case "unrecognized_keys":
      return "Unknown field";
    default:
      return i.message;
  }
}

const pathText = (path: ReadonlyArray<PropertyKey>): string =>
  path.reduce<string>((acc, p) => (typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), "");

export interface Validation {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  profile: ScenarioCoachingProfile | null;
}

/** The authoritative check: the same strict schema the runtime uses, plus the credential-shape guard. */
export function validateContent(org: string, scenarioId: string, content: CoachingDraftContent, profileVersion: number): Validation {
  const errors: Validation["errors"] = [];
  if (SECRET_SHAPES.test(JSON.stringify(content))) errors.push({ path: "content", message: SECRET_MESSAGE });
  const parsed = ScenarioCoachingProfileSchema.safeParse(profileFromContent(org, scenarioId, profileVersion, content));
  if (!parsed.success) for (const issue of parsed.error.issues) errors.push({ path: pathText(issue.path), message: friendly(issue) });
  return { valid: errors.length === 0, errors, profile: parsed.success && errors.length === 0 ? parsed.data : null };
}

function draftView(d: DraftRecord) {
  return { revision: d.draftRevision, content: d.content, contentHash: d.contentHash, updatedAt: d.updatedAt, publishedThroughRevision: d.publishedThroughRevision };
}

function versionSummary(v: VersionRecord, currentVersion: number): CoachingVersionSummary {
  return { profileVersion: v.profileVersion, contentHash: v.contentHash, publishedAt: v.publishedAt, sourceDraftRevision: v.sourceDraftRevision, isCurrent: v.profileVersion === currentVersion };
}

async function loadDraft(deps: ApiDeps, org: string, sid: string, sv: number): Promise<DraftRecord | null> {
  const item = await getDraftItem(deps.db, org, sid, sv);
  if (!item) return null;
  const d = parseDraft(item);
  if (!d || d.organizationId !== org) throw INTERNAL("stored coaching draft is malformed");
  return d;
}

async function currentVersionOf(deps: ApiDeps, org: string, sid: string, sv: number): Promise<number> {
  const item = await getPointerItem(deps.db, org, sid, sv);
  if (!item) return 0;
  const p = parsePointer(item);
  if (!p || p.organizationId !== org) throw INTERNAL("stored coaching pointer is malformed");
  return p.currentProfileVersion;
}

const templateFor = (scenarioId: string, version: number): CoachingDraftContent =>
  contentFromProfile(getBuiltinCoachingProfile(scenarioId, version) ?? DEFAULT_COACHING_PROFILE);

const REVISION_CONFLICT = (): HttpError =>
  new HttpError(409, "REVISION_CONFLICT", "The draft was changed by someone else since you opened it. Reload to see the latest, then re-apply your edit.");

// -- GET scenarios ----------------------------------------------------------------------------------------

export async function handleListCoachingScenarios(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { orgId } = await requireOrgRole(deps, event, MANAGERS);
  const latest = new Map<string, (typeof PUBLISHED_SCENARIOS)[number]>();
  for (const s of PUBLISHED_SCENARIOS) {
    const cur = latest.get(s.content.scenarioId);
    if (!cur || s.content.version > cur.content.version) latest.set(s.content.scenarioId, s);
  }
  const scenarios = [];
  for (const s of latest.values()) {
    const { scenarioId, version, title } = s.content;
    const [current, draft] = await Promise.all([currentVersionOf(deps, orgId, scenarioId, version), loadDraft(deps, orgId, scenarioId, version)]);
    scenarios.push({
      scenarioId, scenarioVersion: version, title,
      targetRole: getBuiltinCoachingProfile(scenarioId, version)?.audience.targetRole ?? null,
      currentProfileVersion: current === 0 ? null : current,
      hasDraft: draft !== null,
    });
  }
  return json(200, ListCoachingScenariosResponseSchema.parse({ scenarios }));
}

// -- GET studio -------------------------------------------------------------------------------------------

export async function handleGetCoachingStudio(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { orgId } = await requireOrgRole(deps, event, MANAGERS);
  const scenario = scenarioOr404(event);
  const { scenarioId, version, title } = scenario.content;

  const [draft, current, items] = await Promise.all([
    loadDraft(deps, orgId, scenarioId, version),
    currentVersionOf(deps, orgId, scenarioId, version),
    queryVersionItems(deps.db, orgId, scenarioId, version),
  ]);
  const versions: CoachingVersionSummary[] = [];
  for (const item of items) {
    const v = parseVersion(item);
    if (!v || v.organizationId !== orgId || v.scenarioId !== scenarioId || v.scenarioVersion !== version) {
      console.error(JSON.stringify({ event: "SKIPPED_COACHING_VERSION", organizationId: orgId, scenarioId }));
      continue;
    }
    versions.push(versionSummary(v, current));
  }
  return json(
    200,
    CoachingStudioResponseSchema.parse({
      scenario: { scenarioId, scenarioVersion: version, title, targetRole: getBuiltinCoachingProfile(scenarioId, version)?.audience.targetRole ?? null },
      template: templateFor(scenarioId, version),
      draft: draft ? draftView(draft) : null,
      versions,
      currentProfileVersion: current === 0 ? null : current,
    }),
  );
}

// -- PUT draft --------------------------------------------------------------------------------------------

export async function handleSaveCoachingDraft(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { auth, orgId } = await requireOrgRole(deps, event, MANAGERS);
  const scenario = scenarioOr404(event);
  const { scenarioId, version } = scenario.content;
  const body = parseBody(event, SaveCoachingDraftRequestSchema, MAX_COACHING_BODY_BYTES);
  if (SECRET_SHAPES.test(JSON.stringify(body.content))) throw new HttpError(422, "CONTENT_REJECTED", SECRET_MESSAGE);
  const now = deps.now();

  if (body.expectedRevision === 0) {
    const item = newDraftItem({ org: orgId, scenarioId, scenarioVersion: version, content: body.content, actorSub: auth.userSub, now });
    if (!(await createDraftIfAbsent(deps.db, item))) {
      const existing = await loadDraft(deps, orgId, scenarioId, version);
      // A retry of the creating request: same author, same content.
      if (existing && existing.draftRevision === 1 && existing.updatedBySub === auth.userSub && existing.contentHash === contentHash(body.content)) {
        return json(200, SaveCoachingDraftResponseSchema.parse({ draft: draftView(existing) }));
      }
      throw REVISION_CONFLICT();
    }
    const created = parseDraft(item);
    if (!created) throw INTERNAL("coaching draft did not validate after creation");
    return json(201, SaveCoachingDraftResponseSchema.parse({ draft: draftView(created) }));
  }

  const existing = await loadDraft(deps, orgId, scenarioId, version);
  if (!existing) throw REVISION_CONFLICT();
  // An identical retry of a save that already landed: same author, same content, exactly one revision ahead.
  if (existing.draftRevision === body.expectedRevision + 1 && existing.updatedBySub === auth.userSub && existing.contentHash === contentHash(body.content)) {
    return json(200, SaveCoachingDraftResponseSchema.parse({ draft: draftView(existing) }));
  }
  if (existing.draftRevision !== body.expectedRevision) throw REVISION_CONFLICT();

  const ok = await updateDraftIfRevision(deps.db, { org: orgId, scenarioId, scenarioVersion: version, expectedRevision: body.expectedRevision, content: body.content, actorSub: auth.userSub, now });
  if (!ok) throw REVISION_CONFLICT();
  const saved = await loadDraft(deps, orgId, scenarioId, version);
  if (!saved) throw INTERNAL("coaching draft vanished after update");
  return json(200, SaveCoachingDraftResponseSchema.parse({ draft: draftView(saved) }));
}

// -- POST validate -------------------------------------------------------------------------------------------

export async function handleValidateCoaching(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { orgId } = await requireOrgRole(deps, event, MANAGERS);
  const scenario = scenarioOr404(event);
  const body = parseBody(event, ValidateCoachingRequestSchema, MAX_COACHING_BODY_BYTES);
  const v = validateContent(orgId, scenario.content.scenarioId, body.content, 1);
  return json(
    200,
    ValidateCoachingResponseSchema.parse({ valid: v.valid, errors: v.errors, effective: describeCoachingBehaviour(body.content.coaching), notice: VALIDATION_NOTICE }),
  );
}

// -- POST publish -------------------------------------------------------------------------------------------

export async function handlePublishCoaching(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { auth, orgId } = await requireOrgRole(deps, event, MANAGERS);
  const scenario = scenarioOr404(event);
  const { scenarioId, version } = scenario.content;
  const body = parseBody(event, PublishCoachingRequestSchema);

  const [draft, current] = await Promise.all([loadDraft(deps, orgId, scenarioId, version), currentVersionOf(deps, orgId, scenarioId, version)]);
  if (!draft) throw new HttpError(409, "NO_DRAFT", "There is no draft to publish. Save a draft first.");

  const respondWith = async (profileVersion: number, status: number, created: boolean): Promise<HttpResult> => {
    const checked = verifyVersion(await getVersionItem(deps.db, orgId, scenarioId, version, profileVersion), { organizationId: orgId, scenarioId, scenarioVersion: version, profileVersion });
    if (!checked.ok) throw INTERNAL(`published coaching version failed verification (${checked.fault})`);
    const latest = await currentVersionOf(deps, orgId, scenarioId, version);
    return json(status, PublishCoachingResponseSchema.parse({ version: versionSummary(checked.record, latest), created }));
  };

  /** Is `profileVersion` exactly this request's earlier, successful publish? */
  const isMyEarlierPublish = async (profileVersion: number): Promise<boolean> => {
    const v = parseVersion(await getVersionItem(deps.db, orgId, scenarioId, version, profileVersion));
    return !!v && v.organizationId === orgId && v.sourceDraftRevision === body.draftRevision && v.publishedBySub === auth.userSub;
  };

  // A retry of a publish that already landed: the pointer moved exactly one step past what the caller expected.
  if (current === body.expectedCurrentVersion + 1 && (await isMyEarlierPublish(current))) return respondWith(current, 200, false);
  if (current !== body.expectedCurrentVersion) {
    throw new HttpError(409, "VERSION_CONFLICT", "A newer coaching version was published since you opened this page. Reload before publishing.");
  }
  if (draft.draftRevision !== body.draftRevision) throw REVISION_CONFLICT();

  const profileVersion = current + 1;
  const validation = validateContent(orgId, scenarioId, draft.content, profileVersion);
  if (!validation.valid || !validation.profile) {
    throw new HttpError(422, "PROFILE_INVALID", `The coaching profile is not valid (${validation.errors.length} problem${validation.errors.length === 1 ? "" : "s"}). Validate the draft to see them.`);
  }

  // Never build on stored state that does not agree with itself. The pointer must lead to a usable version, and the next
  // version number must be free: otherwise something was edited or lost outside the API and a person has to look.
  const inconsistent = (reason: string): never => {
    console.error(JSON.stringify({ event: "COACHING_STATE_INCONSISTENT", reason, organizationId: orgId, scenarioId, current }));
    throw INTERNAL("coaching records are inconsistent");
  };
  if (current > 0 && !verifyVersion(await getVersionItem(deps.db, orgId, scenarioId, version, current), { organizationId: orgId, scenarioId, scenarioVersion: version, profileVersion: current }).ok) {
    inconsistent("POINTER_TARGET_UNUSABLE");
  }
  if (await getVersionItem(deps.db, orgId, scenarioId, version, profileVersion)) inconsistent("NEXT_VERSION_ALREADY_EXISTS");

  const now = deps.now();
  const versionItem = newVersionItem({ org: orgId, scenarioId, scenarioVersion: version, profile: validation.profile, sourceDraftRevision: draft.draftRevision, actorSub: auth.userSub, now });
  try {
    await transactPublish(deps.db, { org: orgId, scenarioId, scenarioVersion: version, version: versionItem, previousVersion: current, draftRevision: draft.draftRevision, actorSub: auth.userSub, now });
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    // Nothing was written (the transaction is all-or-nothing). Say WHY it was cancelled before guessing.
    const codes = cancellationCodes(err);
    if (codes.some((c) => c === "ThrottlingError" || c === "ProvisionedThroughputExceeded")) {
      throw new HttpError(503, "BUSY", "The service is busy. Nothing was published; please try again in a moment.");
    }
    if (codes.includes("TransactionConflict")) {
      throw new HttpError(409, "TRY_AGAIN", "Another change to this configuration was being applied at the same moment. Nothing was published; please try again.");
    }
    if (codes.some((c) => c !== "None" && c !== "ConditionalCheckFailed")) throw err; // validation / size problems are our bug: 500
    // A condition failed: lost a race. Was it our own earlier attempt, a different publish, or an edit to the draft?
    const nowCurrent = await currentVersionOf(deps, orgId, scenarioId, version);
    if (nowCurrent === current + 1 && (await isMyEarlierPublish(nowCurrent))) return respondWith(nowCurrent, 200, false);
    if (nowCurrent !== current) throw new HttpError(409, "VERSION_CONFLICT", "A newer coaching version was published since you opened this page. Reload before publishing.");
    if (codes[0] === "ConditionalCheckFailed") inconsistent("NEXT_VERSION_APPEARED"); // the version slot was taken but the pointer did not move
    throw REVISION_CONFLICT();
  }
  return respondWith(profileVersion, 201, true);
}

// -- GET one version -----------------------------------------------------------------------------------------

export async function handleGetCoachingVersion(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { orgId } = await requireOrgRole(deps, event, MANAGERS);
  const scenario = scenarioOr404(event);
  const { scenarioId, version } = scenario.content;
  const raw = pathParam(event, "profileVersion") ?? "";
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) throw NOT_FOUND();
  const profileVersion = Number(raw);
  const item = await getVersionItem(deps.db, orgId, scenarioId, version, profileVersion);
  if (!item) throw NOT_FOUND();
  const checked = verifyVersion(item, { organizationId: orgId, scenarioId, scenarioVersion: version, profileVersion });
  if (!checked.ok) {
    console.error(JSON.stringify({ event: "COACHING_PROFILE_UNAVAILABLE", where: "inspect", reason: checked.fault, organizationId: orgId, scenarioId, profileVersion }));
    throw INTERNAL("published coaching version failed verification");
  }
  const current = await currentVersionOf(deps, orgId, scenarioId, version);
  const v = checked.record;
  return json(
    200,
    CoachingVersionDetailSchema.parse({ ...versionSummary(v, current), scenarioId, scenarioVersion: version, content: contentFromProfile(v.profile) }),
  );
}
