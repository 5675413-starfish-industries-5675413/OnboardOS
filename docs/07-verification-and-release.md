# 07 — Test matrix, release gates, and truthfulness checks

## Unit tests (Vitest, no AWS required)

- `createSession` initializes exact fixture and scenario version.
- 800ms fails relevant test cases; 1,400ms partially passes; 1,800ms passes; 5,000ms rejected.
- Wrong types and unexpected config keys rejected.
- Published scenario versions never change existing assignment behavior.
- Passing result becomes stale when config hash changes.
- Duplicate client operation doesn't create duplicate events in application idempotency ledger.
- Submission freezes exact config hash, report, suite version, and test-run ID.
- Manager review on a different submission version is rejected.

## API authorization tests

| Test | Expected |
|---|---|
| Anonymous protected request | 401 |
| Employee reads own assignment | 200 |
| Employee accesses other employee's session | 403 or opaque 404 |
| Employee posts manager decision | 403 |
| Manager accesses outside assigned team | 403 or opaque 404 |
| Manager edits organization security policy | 403 |
| Cross-tenant ID guessing | Denied |
| Stale `expectedStateVersion` | 409 |
| Duplicate submit idempotency key | One submission, consistent response |
| Client sends `passed: true` with test request | Ignored/rejected; server computes tests |
| Bedrock text attempts privileged action | No state change |
| Hidden test suite requested from employee API | Not exposed |

## Integration tests (actual AWS account)

- API Gateway → Lambda → DynamoDB read/write with real request IDs.
- Authorized Lambda calls dedicated runner with exact server-derived suite.
- CloudWatch contains execution log for real runner; don't mislabel synthetic incident logs as real telemetry.
- AWS Bedrock inference succeeds for selected configured model and region.
- Reviewer gets a frozen evidence bundle and draft/explicit AI unavailable status.
- Cognito identity or documented controlled demo auth blocks role escalation.
- Artifacts in S3, if used, are private and only granted to authorized reviewer.

## Browser golden path

`Manager assigns → Employee opens → Runs failing initial tests → Saves valid revision → Runs passing tests → Submits report → Bedrock draft generated → Manager requests revision → Employee revises → Manager approves`.

Perform twice from clean sessions on **deployed URLs**, not local mocks. Keep AWS request IDs / test run references as judge-facing evidence.

## Release checklist

- [ ] `main` includes submitted commit; short SHA recorded.
- [ ] `npm run verify` succeeds on that commit.
- [ ] Backend deployed from same commit; API base URL recorded.
- [ ] Frontend deployed from same commit; page refresh works.
- [ ] Admin, manager, employee identities tested against backend permissions.
- [ ] Deterministic test runner verified on real Lambda invocation.
- [ ] Bedrock inference verified on real configured model; or publicly disclose limitation.
- [ ] Test evidence matches exact config revision and suite version.
- [ ] No secrets in repo/history, browser bundle, logs, or screenshot.
- [ ] Demo starts with a predictable clean state.
- [ ] 2-minute video/screenshot backups created from **real** app.
- [ ] Repo link accessible to judges; Devpost team membership complete.
- [ ] Devpost entered and submitted before Nov 8, 9 AM PST.

## Status words

- **Planned** = only docs.
- **Local** = implementation passed local tests.
- **AWS verified** = actual AWS request and response recorded.
- **Deployed** = accessible hosted system tested.
- **Demo ready** = full user workflow proven and disclosed limitations.
- **Enterprise ready** = *not established* by this hackathon.

## Demo fallback order

If a service is down: show actual saved evidence of a previously successful real run with its ID/time, clearly state it is recorded; show source and architecture. Never animate a fake success or claim live AWS actions were performed when they were not.
