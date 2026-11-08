/**
 * AI coworker:
 *   GET  /v1/sessions/{sessionId}/messages   the persisted conversation + whether asking is possible
 *   POST /v1/sessions/{sessionId}/messages   ask one question (Idempotency-Key required)
 *
 * Authorization is the session owner's, via loadOwnedSession (verified subject + ownership + ACTIVE
 * employee membership); anything else is the same opaque 404. The model sees only what
 * coworkerContext.ts is handed, which is employee-visible. Its output is stored and displayed as
 * text. It never reaches the reducer, test status, submissions or reviews.
 *
 * Paid-call discipline (a model call costs money, so the order matters):
 *   1. validate everything cheap (auth, key, body, configuration);
 *   2. a repeat of a request that already has a ledger entry returns the stored turn -- no call;
 *   3. RESERVE the turn atomically (lock + counters + PENDING turn + ledger, see coworkerStore.ts);
 *      only the request that wins this transaction may call Bedrock;
 *   4. call Bedrock once, outside any transaction;
 *   5. finish the turn and release the lock in one conditional transaction.
 *
 * What this can NOT guarantee: if Bedrock accepts a request but the connection fails before we hear
 * back, the service may have processed (and billed) it while we record an ERROR. The user then asks
 * again with a new key. The key only prevents us from re-sending the SAME request ourselves.
 */

import { createHash } from "node:crypto";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  COWORKER_MAX_ATTEMPTS,
  COWORKER_MAX_COMPLETED_TURNS,
  COWORKER_MAX_MESSAGE_CHARS,
  COWORKER_MAX_REPLY_CHARS,
  CoworkerMessageRequestSchema,
  ListCoworkerMessagesResponseSchema,
  PostCoworkerMessageResponseSchema,
  CoworkerStateSchema,
  type CoworkerState,
} from "@onboardos/contracts";
import { isCurrentRun, type WorkplaceState } from "@onboardos/scenario-engine";
import {
  COWORKER_ERROR_MESSAGES,
  CoworkerProviderError,
  type BedrockProvider,
  type CoworkerErrorCode,
} from "../bedrock.js";
import { resolveCoachingForAssignment } from "../coachingRuntime.js";
import { COWORKER_PROMPT_VERSION, buildCoworkerRequest, type PriorTurn } from "../coworkerContext.js";
import {
  FRESH_CONTROL,
  LEASE_MS,
  buildPendingTurn,
  chatKeys,
  getControlItem,
  getLedgerItem,
  getTurnItem,
  leaseExpired,
  newTurnId,
  parseControl,
  parseLedger,
  parseTurn,
  queryTurnItems,
  toTurnView,
  transactFinishTurn,
  transactReserveTurn,
  type ControlRecord,
  type TurnOutcome,
  type TurnRecord,
} from "../coworkerStore.js";
import type { ApiDeps } from "../deps.js";
import { HttpError, json, parseBody, type HttpResult } from "../http.js";
import { parseAssignment, parseSessionState, parseTestRun } from "../records.js";
import { getAssignmentItem, getSessionItem, isTransactionCanceled, queryTestRuns } from "../repo.js";
import { INTERNAL, loadOwnedSession, scenarioFor } from "./sessions.js";
import { idempotencyKey } from "./submissions.js";

const MAX_RESERVE_ATTEMPTS = 3;
const MAX_BODY_BYTES = 2048;

const UNAVAILABLE = (): HttpError => new HttpError(503, "AI_UNAVAILABLE", COWORKER_ERROR_MESSAGES.AI_UNAVAILABLE);

function requestHash(message: string): string {
  return createHash("sha256").update(`coworker-message-v1\n${message}`, "utf8").digest("hex");
}

/** The control item, or a fresh one for a session that never used chat. A malformed one fails closed. */
async function loadControl(deps: ApiDeps, sessionId: string): Promise<{ record: ControlRecord; exists: boolean }> {
  const item = await getControlItem(deps.db, sessionId);
  if (!item) return { record: FRESH_CONTROL(sessionId, deps.now()), exists: false };
  const record = parseControl(item);
  if (!record || record.sessionId !== sessionId) throw INTERNAL("stored coworker control item is malformed");
  return { record, exists: true };
}

function describeState(
  provider: BedrockProvider | null,
  phase: WorkplaceState["phase"],
  control: ControlRecord,
  nowIso: string,
): CoworkerState {
  const busy = control.ctlActive !== null && !leaseExpired(control, nowIso);
  let reason: string | null = null;
  if (!provider) reason = "The AI coworker is not available in this deployment.";
  else if (phase !== "INVESTIGATING") reason = "This attempt has been submitted, so the conversation is read-only.";
  else if (busy) reason = "Your coworker is still answering the last question.";
  else if (control.ctlCompleted >= COWORKER_MAX_COMPLETED_TURNS) reason = `You have used all ${COWORKER_MAX_COMPLETED_TURNS} questions for this session.`;
  else if (control.ctlAttempts >= COWORKER_MAX_ATTEMPTS) reason = "This session has reached its limit of coworker requests.";
  return CoworkerStateSchema.parse({
    enabled: provider !== null,
    canSend: reason === null,
    reason,
    modelId: provider?.modelId ?? null,
    completedTurns: control.ctlCompleted,
    attemptsUsed: control.ctlAttempts,
    limits: {
      maxMessageChars: COWORKER_MAX_MESSAGE_CHARS,
      maxCompletedTurns: COWORKER_MAX_COMPLETED_TURNS,
      maxAttempts: COWORKER_MAX_ATTEMPTS,
    },
  });
}

/** Close an abandoned reservation (lease expired) so it cannot hold the session forever. Best effort. */
async function reconcileStranded(deps: ApiDeps, sessionId: string): Promise<void> {
  const { record: control } = await loadControl(deps, sessionId);
  if (control.ctlActive === null || !leaseExpired(control, deps.now())) return;
  const outcome: TurnOutcome = { kind: "ERROR", code: "STRANDED", message: COWORKER_ERROR_MESSAGES.STRANDED, requestId: null };
  try {
    await transactFinishTurn(deps.db, { sessionId, turnId: control.ctlActive, control, outcome, now: deps.now() });
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    // Someone else closed it (or its owner finished just now): nothing to do.
  }
}

async function loadTurns(deps: ApiDeps, sessionId: string): Promise<TurnRecord[]> {
  const out: TurnRecord[] = [];
  for (const item of await queryTurnItems(deps.db, sessionId)) {
    const t = parseTurn(item);
    if (t && t.sessionId === sessionId) out.push(t);
    else console.error(JSON.stringify({ event: "SKIPPED_COWORKER_TURN", sessionId }));
  }
  return out;
}

// -- GET ----------------------------------------------------------------------

export async function handleListMessages(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { state } = await loadOwnedSession(deps, event);
  await reconcileStranded(deps, state.sessionId);
  const [turns, { record: control }] = await Promise.all([loadTurns(deps, state.sessionId), loadControl(deps, state.sessionId)]);
  return json(
    200,
    ListCoworkerMessagesResponseSchema.parse({
      turns: turns.map(toTurnView),
      coworker: describeState(deps.coworker(), state.phase, control, deps.now()),
    }),
  );
}

// -- POST ---------------------------------------------------------------------

async function respondWithTurn(
  deps: ApiDeps,
  state: WorkplaceState,
  provider: BedrockProvider | null,
  turnId: string,
  status: number,
  created: boolean,
): Promise<HttpResult> {
  const turn = parseTurn(await getTurnItem(deps.db, state.sessionId, turnId));
  if (!turn || turn.sessionId !== state.sessionId) throw INTERNAL("coworker turn is missing or malformed");
  const { record: control } = await loadControl(deps, state.sessionId);
  // The phase is read NOW, not taken from the start of the request: the attempt may have been submitted while
  // the model was answering, and the response must not tell the employee they can still ask.
  const latest = parseSessionState(await getSessionItem(deps.db, state.sessionId));
  if (!latest) throw INTERNAL("stored session is missing or malformed");
  return json(
    status,
    PostCoworkerMessageResponseSchema.parse({
      turn: toTurnView(turn),
      coworker: describeState(provider, latest.phase, control, deps.now()),
      created,
    }),
  );
}

/** A request whose key already has a ledger entry: same content returns the stored turn; different content is refused. */
async function replayIfLedgered(
  deps: ApiDeps,
  state: WorkplaceState,
  provider: BedrockProvider,
  key: string,
  hash: string,
): Promise<HttpResult | null> {
  const item = await getLedgerItem(deps.db, state.sessionId, key);
  if (!item) return null;
  const ledger = parseLedger(item);
  if (!ledger) throw INTERNAL("stored coworker idempotency record is malformed");
  if (ledger.requestHash !== hash) {
    throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "That Idempotency-Key was already used for a different message");
  }
  await reconcileStranded(deps, state.sessionId);
  return respondWithTurn(deps, state, provider, ledger.turnId, 200, false);
}

export async function handleSendMessage(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { state, sub } = await loadOwnedSession(deps, event);
  const key = idempotencyKey(event);
  const body = parseBody(event, CoworkerMessageRequestSchema, MAX_BODY_BYTES);
  const provider = deps.coworker();
  if (!provider) throw UNAVAILABLE();
  const message = body.message;
  const hash = requestHash(message);

  const replay = await replayIfLedgered(deps, state, provider, key, hash);
  if (replay) return replay;

  const scenario = scenarioFor(state.scenarioId, state.scenarioVersion);

  // The coaching comes from THIS assignment: its frozen organization-published reference if it has one, else the built-in
  // profile. A reference that cannot be verified is refused here, before any reservation or model call; it is never replaced.
  const assignment = parseAssignment(await getAssignmentItem(deps.db, state.assignmentId));
  if (!assignment || assignment.organizationId !== state.organizationId || assignment.employeeSub !== sub) {
    throw INTERNAL("the session's assignment is missing or does not match");
  }
  const coaching = await resolveCoachingForAssignment(deps, assignment, scenario);

  // -- reserve ---------------------------------------------------------------
  let turn: TurnRecord | null = null;
  let pendingRequest: ReturnType<typeof buildCoworkerRequest> | null = null;
  let current = state;

  for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS && !turn; attempt++) {
    const fresh = parseSessionState(await getSessionItem(deps.db, state.sessionId));
    if (!fresh) throw INTERNAL("stored session is missing or malformed");
    current = fresh;
    if (current.phase !== "INVESTIGATING") {
      throw new HttpError(409, "SESSION_NOT_OPEN", "This attempt is no longer open, so the AI coworker cannot be asked anything new");
    }

    const now = deps.now();
    const { record: control, exists } = await loadControl(deps, state.sessionId);
    if (control.ctlActive !== null && !leaseExpired(control, now)) {
      throw new HttpError(409, "COWORKER_BUSY", "Your coworker is still answering the last question");
    }
    if (control.ctlCompleted >= COWORKER_MAX_COMPLETED_TURNS || control.ctlAttempts >= COWORKER_MAX_ATTEMPTS) {
      throw new HttpError(429, "COWORKER_LIMIT_REACHED", "This session has used its AI coworker allowance");
    }

    // Everything the model will be told is built BEFORE the reservation, from authorized records.
    const history = await historyFor(deps, state.sessionId);
    const currentRun = await currentRunFor(deps, current, scenario.testSuiteVersion);
    const request = buildCoworkerRequest({ scenario, coaching: coaching.profile, state: current, currentRun, history, message });

    // A previous holder whose lease expired is closed in the same transaction.
    let stranded: { turnId: string; code: string; message: string } | null = null;
    if (control.ctlActive !== null) {
      const old = parseTurn(await getTurnItem(deps.db, state.sessionId, control.ctlActive));
      if (old && old.status === "PENDING") {
        stranded = { turnId: old.turnId, code: "STRANDED", message: COWORKER_ERROR_MESSAGES.STRANDED };
      }
    }

    const turnId = newTurnId(now, deps.newId());
    const pending = buildPendingTurn({
      sessionId: state.sessionId,
      organizationId: state.organizationId,
      employeeSub: sub,
      turnId,
      userText: message,
      modelId: provider.modelId,
      promptVersion: COWORKER_PROMPT_VERSION,
      coaching: {
        profileId: coaching.profile.profileId,
        profileVersion: coaching.profile.profileVersion,
        hash: coaching.hash,
        source: coaching.source,
      },
      now,
    });
    const nextControl: ControlRecord = {
      ...control,
      ctlRev: control.ctlRev + 1,
      ctlActive: turnId,
      ctlLease: new Date(Date.parse(now) + LEASE_MS).toISOString(),
      ctlAttempts: control.ctlAttempts + 1,
      ctlUpdatedAt: now,
    };

    try {
      await transactReserveTurn(deps.db, {
        sessionId: state.sessionId,
        employeeSub: sub,
        control: exists ? control : null,
        nextControl,
        stranded,
        turn: pending,
        ledger: {
          ...chatKeys.ledger(state.sessionId, key),
          entityType: "COWORKER_IDEMPOTENCY",
          requestHash: hash,
          turnId,
          createdAt: now,
        },
        now,
      });
      turn = pending;
      pendingRequest = request;
    } catch (err) {
      if (!isTransactionCanceled(err)) throw err;
      // Lost a race. If it was the same request, return its turn; otherwise look again.
      const raced = await replayIfLedgered(deps, state, provider, key, hash);
      if (raced) return raced;
    }
  }
  if (!turn || !pendingRequest) {
    throw new HttpError(409, "COWORKER_BUSY", "Your coworker could not take the question; please try again");
  }

  // -- call (only the reservation winner reaches here) -------------------------
  let outcome: TurnOutcome;
  try {
    const reply = await provider.converse(pendingRequest);
    const text = reply.text.length > COWORKER_MAX_REPLY_CHARS ? reply.text.slice(0, COWORKER_MAX_REPLY_CHARS) : reply.text;
    outcome = {
      kind: "COMPLETE",
      reply: text,
      truncated: reply.truncated || text.length < reply.text.length,
      usage: { input: reply.inputTokens, output: reply.outputTokens },
      requestId: reply.requestId,
      stopReason: reply.stopReason,
      latencyMs: reply.latencyMs,
    };
  } catch (err) {
    const code: CoworkerErrorCode = err instanceof CoworkerProviderError ? err.code : "AI_ERROR";
    outcome = {
      kind: "ERROR",
      code,
      message: COWORKER_ERROR_MESSAGES[code],
      requestId: err instanceof CoworkerProviderError ? err.requestId : null,
    };
  }

  // Structured log: no prompt, no reply, no user text.
  console.log(
    JSON.stringify({
      event: "coworker_turn",
      turnId: turn.turnId,
      status: outcome.kind,
      errorCode: outcome.kind === "ERROR" ? outcome.code : null,
      stopReason: outcome.kind === "COMPLETE" ? outcome.stopReason : null,
      inputTokens: outcome.kind === "COMPLETE" ? outcome.usage.input : null,
      outputTokens: outcome.kind === "COMPLETE" ? outcome.usage.output : null,
      requestId: outcome.requestId,
      latencyMs: outcome.kind === "COMPLETE" ? outcome.latencyMs : null,
      modelId: provider.modelId,
      promptVersion: COWORKER_PROMPT_VERSION,
      coachingProfileId: turn.coachingProfileId ?? null,
      coachingProfileVersion: turn.coachingProfileVersion ?? null,
      coachingProfileSource: turn.coachingProfileSource ?? null,
    }),
  );

  // -- finish ----------------------------------------------------------------
  const { record: control } = await loadControl(deps, state.sessionId);
  if (control.ctlActive === turn.turnId) {
    try {
      await transactFinishTurn(deps.db, { sessionId: state.sessionId, turnId: turn.turnId, control, outcome, now: deps.now() });
    } catch (err) {
      if (!isTransactionCanceled(err)) throw err;
      console.error(JSON.stringify({ event: "COWORKER_FINISH_LOST_RACE", turnId: turn.turnId }));
    }
  } else {
    // The lease was taken over while we waited: the turn was already closed as STRANDED. The late answer is discarded.
    console.error(JSON.stringify({ event: "COWORKER_LATE_RESULT_DISCARDED", turnId: turn.turnId }));
  }
  return respondWithTurn(deps, current, provider, turn.turnId, 201, true);
}

async function historyFor(deps: ApiDeps, sessionId: string): Promise<PriorTurn[]> {
  const out: PriorTurn[] = [];
  for (const t of await loadTurns(deps, sessionId)) {
    if (t.status === "COMPLETE" && t.replyText) out.push({ userText: t.userText, reply: t.replyText });
  }
  return out;
}

/** The newest finished run whose revision, hash and suite version equal the session's current ones. */
async function currentRunFor(deps: ApiDeps, state: WorkplaceState, suiteVersion: number) {
  for (const item of await queryTestRuns(deps.db, state.sessionId)) {
    const run = parseTestRun(item);
    if (run && run.sessionId === state.sessionId && run.status !== "PENDING" && isCurrentRun(run, state, suiteVersion)) return run;
  }
  return null;
}
