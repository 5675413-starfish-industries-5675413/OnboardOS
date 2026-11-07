# 04 — Domain model, DynamoDB keys, and API contracts

## Authoritative entities

`User` (identity provider subject), `Organization`, `Membership`, `Team`, `RoleBlueprint`, `ScenarioTemplate`, `Assignment`, `Session`, `ConfigRevision`, `TestRun`, `ChatMessage`, `ActionEvent`, `Submission`, `EvaluationDraft`, `ManagerReview`, `Artifact`.

Don't collapse authorization role into the user record. Membership is `(userSub, organizationId, role, teamIds, status)`.

## Persistence choice

- `OnboardOSCore`: current state, memberships, assignments, scenarios, config revisions, test runs, submission/review records.
- `OnboardOSEvents`: per-session append-only event history.
- `OnboardOSEvidence` S3: large reports/replay chunks if necessary; private, short-lived presigned access via backend.
- The hackathon can use two explicit DynamoDB tables and narrow GSIs; avoid a clever generic single-table design whose key patterns nobody on the team understands.

## Concrete key/access patterns (planned)

Use `PK` and `SK` on core records; every object includes `organizationId` and authenticated `createdBy` where relevant.

| Access pattern | Suggested key / index |
|---|---|
| Load organization | `PK=ORG#orgId, SK=PROFILE` |
| Load org membership | `PK=ORG#orgId, SK=MEMBER#userSub` |
| List org members | Query `PK=ORG#orgId`, `begins_with(SK,'MEMBER#')` |
| Load scenario version | `PK=ORG#orgId, SK=SCENARIO#scenarioId#vN` |
| Load assignment | `PK=ASSIGN#assignmentId, SK=META` |
| List employee assignments | GSI `GSI1PK=ORG#orgId#EMP#userSub`, `GSI1SK=ASSIGN#createdAt#id` |
| List manager review queue | GSI `GSI2PK=ORG#orgId#MANAGER#userSub`, `GSI2SK=STATUS#status#submittedAt#id` |
| Load session | `PK=SESSION#sessionId, SK=STATE` |
| Load config revisions | `PK=SESSION#sessionId`, `SK=CONFIG#revision` |
| Load test runs | `PK=SESSION#sessionId`, `SK=TEST#createdAt#id` |
| Load submissions | `PK=SESSION#sessionId`, `SK=SUBMISSION#attemptNumber` |
| Load individual manager review | `PK=SUBMISSION#submissionId`, `SK=REVIEW#decisionId` |
| Read event stream | Event table `PK=SESSION#sessionId`, `SK=SEQ#zeroPaddedSequence` |

**Important implementation caveat:** The manager queue index needs a way to update/index a submission when it becomes reviewable. Store a review-queue item or GSI projection in one authoritative workflow, not by assuming scanning arbitrary submissions works. Define the exact GSI and update transaction before coding.

For a 22-hour build, it is acceptable to seed one org and return a small list by manager's assigned-employee IDs, provided each fetched assignment is authorized and there is no table-wide cross-tenant scan. The proposed GSI scheme is the production-oriented direction.

## Transactions and idempotency

Use `TransactWriteItems` for state + event writes, conditional on `stateVersion`. For each externally retried business action, store an application-level request ledger key scoped to actor+action+idempotencyKey. AWS `ClientRequestToken` alone guarantees deduplication for only a **10-minute window**, so longer-lived API idempotency requires stored keys.

Long-running Bedrock and Lambda calls must not run *inside* database transactions. Use request records/statuses plus bounded retries and reconcilable final states.

## API conventions

- JSON UTF-8; stable API prefix `/v1`.
- Identity derived from verified token; client-provided roles/user IDs never authorize.
- Pagination for lists; `GET /me` contains only authorized memberships.
- Mutation requires `Idempotency-Key` header where appropriate and `expectedStateVersion` for session state changes.
- Errors `{code, message, requestId}`; statuses: `400` malformed, `401` unauthenticated, `403` denied, `404` inaccessible/not found, `409` version conflict, `422` invalid scenario action, `429` quota, `5xx` backend failure.
- Request and response contracts defined once with Zod in `packages/contracts`; never expose private grader, hidden tests, or unfiltered database records.

## Routes by implementation dependency

| Priority | Method and path | Actor | Action |
|---|---|---|---|
| P0 | `GET /v1/health` | Public | Health check, no secrets |
| P0 | `GET /v1/me` | Authenticated | Identity + org memberships |
| P0 | `GET /v1/orgs/:orgId/assignments` | Scoped | My assignments or managed queue |
| P0 | `POST /v1/orgs/:orgId/assignments` | Manager/admin | Create an assignment |
| P0 | `POST /v1/assignments/:id/start` | Assigned employee | Start/resume session |
| P0 | `GET /v1/sessions/:id` | Session owner; preview limited | Employee-visible state |
| P0 | `POST /v1/sessions/:id/actions` | Session owner | Validated workplace state action |
| P0 | `PUT /v1/sessions/:id/config` | Session owner | Save config revision |
| P0 | `POST /v1/sessions/:id/test-runs` | Session owner | Invoke predefined test suite |
| P0 | `POST /v1/sessions/:id/submissions` | Session owner | Freeze report + evidence |
| P0 | `GET /v1/reviews/:submissionId` | Scoped manager/admin | Evidence bundle + AI draft |
| P0 | `POST /v1/reviews/:submissionId/decision` | Scoped manager/admin | Approve or request revision |
| P1 | `POST /v1/sessions/:id/messages` | Session owner | Bedrock coworker |
| P1 | `PATCH /v1/orgs/:orgId/blueprints/:id` | Admin | Change published configuration for new sessions |
| P2 | `POST /v1/orgs/:orgId/invitations` | Admin | Invitation process |
| P2 | `POST /v1/sessions/:id/reset` | Scoped | New attempt |

## Example request / response

```json
// PUT /v1/sessions/s123/config
{
  "expectedStateVersion": 4,
  "config": {"request_timeout_ms": 1800}
}
```

```json
// 200 response; values illustrative
{
  "sessionId": "s123",
  "stateVersion": 5,
  "configRevision": 2,
  "configHash": "sha256:<calculated server-side>",
  "currentTestEvidence": false
}
```

The `configHash` must be computed from canonical serialized, validated JSON. A prior pass must never be attached to a new hash.

## Artifact privacy

Never put secrets, production tokens, or unnecessary personal details into events, S3 objects, model prompts, or logs. S3 bucket private by default; authorize user against `organizationId` and `submissionId` before issuing a bounded presigned URL. Use lifecycle/retention settings that are visible to authorized admins in the enterprise product.
