/**
 * Manager review of a frozen submission:
 *   GET  /v1/reviews/{submissionId}            read-only evidence bundle
 *   POST /v1/reviews/{submissionId}/decision   APPROVE or REQUEST_REVISION (once, immutable)
 *
 * Authorization is re-derived on every call from the verified subject, an ACTIVE membership
 * in the assignment's organization and the real assigner/reviewer relationship (see
 * canReview). Everything else -- unknown id, other tenant, other manager's employee, the
 * employee themself -- is the same opaque 404, so submission ids cannot be probed.
 *
 * The decision is an append-only item at a deterministic key (one slot per submission,
 * create-if-absent), committed in ONE transaction with the session's REVIEW_DECIDED event
 * and the assignment transition. Two managers racing, or the same manager twice, cannot both win.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import {
  MAX_ATTEMPTS,
  ReviewBundleResponseSchema,
  ReviewDecisionRequestSchema,
  type ReviewBundle,
  type TimelineEntry,
} from "@onboardos/contracts";
import { SYSTEM_ACTOR, reduceScenario } from "@onboardos/scenario-engine";
import { authenticate, canReview, loadActiveMembership, NOT_FOUND } from "../authz.js";
import type { ApiDeps } from "../deps.js";
import { HttpError, json, parseBody, pathParam, type HttpResult } from "../http.js";
import { parseSubmissionId } from "../ids.js";
import {
  buildDecisionRecord,
  eventItem,
  parseAssignment,
  parseDecision,
  parseSessionState,
  parseSubmission,
  sessionItem,
  toSubmissionSummary,
  toSubmissionView,
  type AssignmentRecord,
  type DecisionRecord,
  type SubmissionRecord,
} from "../records.js";
import {
  getAssignmentItem,
  getDecisionItem,
  getSessionItem,
  getSubmissionItem,
  isTransactionCanceled,
  queryDecisions,
  queryEvents,
  querySubmissions,
  transactApplyAction,
  CREATE_ONLY,
} from "../repo.js";
import { INTERNAL, scenarioFor } from "./sessions.js";
import { rejectionToError } from "./rejections.js";

interface ReviewContext {
  sub: string;
  reviewerName: string;
  assignment: AssignmentRecord;
  submission: SubmissionRecord;
}

/** Resolve and authorize the submission in the URL, or throw the opaque 404. */
async function authorizeReview(deps: ApiDeps, event: APIGatewayProxyEventV2): Promise<ReviewContext> {
  const { userSub: sub } = authenticate(event);
  const submissionId = pathParam(event, "submissionId") ?? "";
  const ids = parseSubmissionId(submissionId);
  if (!ids) throw NOT_FOUND();

  const assignmentItem = await getAssignmentItem(deps.db, ids.assignmentId);
  if (!assignmentItem) throw NOT_FOUND();
  const assignment = parseAssignment(assignmentItem);
  if (!assignment) throw INTERNAL("stored assignment is malformed");

  const member = await loadActiveMembership(deps, assignment.organizationId, sub);
  if (!member || !canReview(member, assignment)) throw NOT_FOUND();

  const submissionItem = await getSubmissionItem(deps.db, ids.assignmentId, ids.attempt);
  if (!submissionItem) throw NOT_FOUND();
  const submission = parseSubmission(submissionItem);
  if (!submission) throw INTERNAL("stored submission is malformed");
  // The submission must really belong to this assignment, tenant and employee.
  if (
    submission.submissionId !== submissionId ||
    submission.assignmentId !== assignment.assignmentId ||
    submission.organizationId !== assignment.organizationId ||
    submission.employeeSub !== assignment.employeeSub
  ) {
    throw INTERNAL("submission does not match its assignment");
  }
  return { sub, reviewerName: member.displayName, assignment, submission };
}

// -- evidence timeline ------------------------------------------------------------

const StoredEventSchema = z.looseObject({
  PK: z.string(),
  SK: z.string().startsWith("SEQ#"),
  type: z.string(),
  stateVersion: z.number().int().positive(),
  occurredAt: z.string(),
  actorSub: z.string(),
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

/** A short, factual description built only from server-recorded fields. */
function describeEvent(type: string, p: Record<string, string | number | boolean>): string {
  switch (type) {
    case "INVESTIGATION_STARTED": return "Started the investigation";
    case "TICKET_OPENED": return "Opened the incident ticket";
    case "RUNBOOK_OPENED": return "Opened the runbook";
    case "DIAGNOSTICS_OPENED": return "Opened the synthetic diagnostics";
    case "CONFIG_SAVED": return `Saved configuration revision ${p["revision"]} (request_timeout_ms ${p["request_timeout_ms"]})`;
    case "TEST_RUN_REQUESTED": return `Requested a test run on configuration revision ${p["configRevision"]}`;
    case "TEST_RUN_COMPLETED": return `Test run finished: ${p["outcome"]}`;
    case "SUBMISSION_CREATED": return `Submitted the incident report (attempt ${p["attemptNumber"]})`;
    case "REVIEW_DECIDED": return `Manager decision recorded: ${p["decision"]}`;
    default: return type;
  }
}

async function loadTimeline(deps: ApiDeps, submission: SubmissionRecord): Promise<TimelineEntry[]> {
  const out: TimelineEntry[] = [];
  for (const item of await queryEvents(deps.db, submission.sessionId)) {
    const parsed = StoredEventSchema.safeParse(item);
    if (!parsed.success || parsed.data.PK !== `SESSION#${submission.sessionId}`) {
      console.error(JSON.stringify({ event: "SKIPPED_EVENT_RECORD", sessionId: submission.sessionId }));
      continue;
    }
    const e = parsed.data;
    // The frozen evidence ends at the submission event; later events (the decision) are not evidence.
    if (e.stateVersion > submission.evidence.eventSequence) continue;
    out.push({
      sequence: e.stateVersion,
      type: e.type,
      occurredAt: e.occurredAt,
      actor: e.actorSub === SYSTEM_ACTOR ? "SYSTEM" : e.actorSub === submission.employeeSub ? "EMPLOYEE" : "REVIEWER",
      summary: describeEvent(e.type, e.payload),
    });
  }
  return out;
}

async function buildBundle(deps: ApiDeps, ctx: ReviewContext): Promise<ReviewBundle> {
  const { assignment, submission } = ctx;
  const [subItems, decItems, timeline] = await Promise.all([
    querySubmissions(deps.db, assignment.assignmentId),
    queryDecisions(deps.db, assignment.assignmentId),
    loadTimeline(deps, submission),
  ]);

  const decisions: DecisionRecord[] = [];
  for (const item of decItems) {
    const d = parseDecision(item);
    if (d && d.assignmentId === assignment.assignmentId) decisions.push(d);
  }
  const decisionFor = (id: string) => decisions.find((d) => d.submissionId === id);

  const history = [];
  for (const item of subItems) {
    const s = parseSubmission(item);
    if (s && s.assignmentId === assignment.assignmentId) history.push(toSubmissionSummary(s, decisionFor(s.submissionId)));
  }

  const decision = decisionFor(submission.submissionId);
  return {
    submission: toSubmissionView(submission, decision),
    employee: { userSub: assignment.employeeSub, displayName: assignment.employeeDisplayName },
    assignment: {
      assignmentId: assignment.assignmentId,
      scenarioTitle: assignment.scenarioTitle,
      status: assignment.status,
      attemptNumber: assignment.attemptNumber,
      latestSubmissionId: assignment.latestSubmissionId,
    },
    history,
    timeline,
    canDecide:
      decision === undefined &&
      assignment.status === "AWAITING_REVIEW" &&
      assignment.latestSubmissionId === submission.submissionId,
  };
}

// -- GET /v1/reviews/{submissionId} -----------------------------------------------

export async function handleGetReview(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const ctx = await authorizeReview(deps, event);
  return json(200, ReviewBundleResponseSchema.parse({ review: await buildBundle(deps, ctx) }));
}

// -- POST /v1/reviews/{submissionId}/decision -------------------------------------

export async function handleDecideReview(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const ctx = await authorizeReview(deps, event);
  const body = parseBody(event, ReviewDecisionRequestSchema);
  const feedback = body.feedback && body.feedback.length > 0 ? body.feedback : null;
  const { submission, assignment, sub } = ctx;

  // A decision is final. The identical decision by the same reviewer is an idempotent retry;
  // anything else (a different decision, another reviewer) is refused, never an overwrite.
  const sameAs = (d: DecisionRecord) => d.reviewerSub === sub && d.decision === body.decision && d.feedback === feedback;
  const existing = parseDecision(await getDecisionItem(deps.db, assignment.assignmentId, submission.attemptNumber));
  if (existing) {
    if (sameAs(existing)) {
      return json(200, ReviewBundleResponseSchema.parse({ review: await buildBundle(deps, ctx) }));
    }
    throw new HttpError(409, "ALREADY_DECIDED", "A decision has already been recorded for this submission");
  }

  // Only the frozen submission currently under review can be decided.
  if (assignment.latestSubmissionId !== submission.submissionId || assignment.status !== "AWAITING_REVIEW") {
    throw new HttpError(409, "NOT_AWAITING_REVIEW", "This submission is not awaiting review");
  }
  if (body.decision === "REQUEST_REVISION" && submission.attemptNumber >= MAX_ATTEMPTS) {
    throw new HttpError(422, "ATTEMPT_LIMIT_REACHED", "This was the final allowed attempt; approve it or handle it outside the app");
  }

  const state = parseSessionState(await getSessionItem(deps.db, submission.sessionId));
  if (
    !state ||
    state.submissionId !== submission.submissionId ||
    state.assignmentId !== assignment.assignmentId ||
    state.employeeSub !== assignment.employeeSub ||
    state.organizationId !== assignment.organizationId
  ) {
    throw INTERNAL("the submitted session is missing or inconsistent with its submission");
  }
  const scenario = scenarioFor(state.scenarioId, state.scenarioVersion);

  const now = deps.now();
  // The version is read here, by the server; the reviewer never supplies one. A concurrent
  // writer makes the transaction cancel below.
  const result = reduceScenario(
    scenario,
    state,
    { type: "RECORD_REVIEW", submissionId: submission.submissionId, decision: body.decision, expectedVersion: state.stateVersion },
    { now, actorSub: sub },
  );
  if (!result.ok) throw rejectionToError(result.error);

  const decisionRecord = buildDecisionRecord({
    submission,
    decision: body.decision,
    feedback,
    reviewerSub: sub,
    reviewerDisplayName: ctx.reviewerName,
    now,
  });

  try {
    await transactApplyAction(deps.db, {
      nextSessionItem: sessionItem(result.nextState),
      eventItems: result.events.map((e) => eventItem(result.nextState, e)),
      expectedVersion: state.stateVersion,
      extraCorePuts: [{ item: decisionRecord as Record<string, unknown>, condition: CREATE_ONLY }],
      extraCoreUpdates: [
        {
          key: { PK: `ASSIGN#${assignment.assignmentId}`, SK: "META" },
          expression: "SET #status = :next, updatedAt = :now",
          condition: "#status = :awaiting AND latestSubmissionId = :submissionId",
          names: { "#status": "status" },
          values: {
            ":next": body.decision === "APPROVE" ? "APPROVED" : "REVISION_REQUESTED",
            ":awaiting": "AWAITING_REVIEW",
            ":submissionId": submission.submissionId,
            ":now": now,
          },
        },
      ],
    });
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    // Someone else decided (or the session moved) between our read and our write.
    const raced = parseDecision(await getDecisionItem(deps.db, assignment.assignmentId, submission.attemptNumber));
    if (raced) {
      if (sameAs(raced)) return json(200, ReviewBundleResponseSchema.parse({ review: await buildBundle(deps, ctx) }));
      throw new HttpError(409, "ALREADY_DECIDED", "A decision has already been recorded for this submission");
    }
    throw new HttpError(409, "CONFLICT", "The review could not be recorded; reload and try again");
  }

  // Re-read the assignment so the bundle reflects the committed status.
  const fresh = parseAssignment(await getAssignmentItem(deps.db, assignment.assignmentId));
  if (!fresh) throw INTERNAL("assignment disappeared after a committed decision");
  return json(200, ReviewBundleResponseSchema.parse({ review: await buildBundle(deps, { ...ctx, assignment: fresh }) }));
}
