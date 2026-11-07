# OnboardOS — coding agent operating contract

## Purpose

Build a **working 22-hour AWS hackathon demo**, not a pretend enterprise production platform. The primary path is: Admin config → Manager assignment → Employee incident investigation → Saved config revision → Genuine AWS test run → Frozen evidence + report → Bedrock draft → Human review.

Read `README.md`, `docs/00-product-and-scope.md`, `docs/03-scenario-engine.md`, `docs/04-data-and-api.md`, `docs/07-verification-and-release.md` before modifying code.

## Nonnegotiable invariants

1. TypeScript end-to-end and shared Zod contracts; npm workspaces.
2. Authorization is enforced **server-side** by validated user identity + organization membership + team/resource/action scope.
3. A true scenario state has one authoritative backend owner; never persist a client-computed pass or status.
4. The deterministic engine is pure and independently unit-testable; Bedrock cannot decide tests, role changes, or approvals.
5. Hidden test cases, manager-only rubrics, AWS credentials and sensitive artifacts never enter the frontend bundle or coworker context.
6. Test outcomes refer to exact `configRevision`, `configHash`, and test-suite version. Any later edit renders former success stale relative to current work.
7. Successful state updates and events are transactional/versioned; handle retries idempotently.
8. Submission evidence is frozen; resubmissions create new immutable versions; manager decisions append, not overwrite.
9. Distinguish synthetic incident evidence from actual AWS execution logs.
10. No arbitrary code execution, real customer production integration, credential copying, or unrestricted AWS access.
11. No fake 'complete', 'passed', 'deployed', 'merged', 'cloud verified', or 'Bedrock evaluated' states. Report failure honestly.
12. Do not introduce unrequested frameworks, dependencies, services, or unrelated edits.

## How to execute tasks

- Begin by inspecting actual files, `git status`, branch and latest commit, and relevant contracts.
- State the exact feature boundary and files expected to change.
- Implement one vertical slice at a time, with tests for its failure and denial paths.
- Verify locally. If AWS is required, explicitly label results `not verified` until an actual authorized request succeeds.
- End with: files changed, commands run and results, actual branch/commit/PR status, deployment status, unresolved risk, next small integration action.
- Before claiming a merge, verify the commit is in `main` and frontend/backend were deployed from that SHA.

## Build order

Repo+contracts → pure engine+tests → minimal AWS API+DB+runner → auth → manager assignment → employee workspace → revision/test path → frozen submission/review → Bedrock → QA/polish → Devpost.

## Owner safety

Multiple agents must not edit the same file concurrently. Route shared contracts through one owner. One deployment owner manages the shared AWS stack. Avoid requiring a PR approval rule that blocks a last-minute merge. Respect hackathon originality and team rules.

## Evidence needed for completion

`npm run verify` green and **the entire deployed golden path** tested from clean session. If either fails, tell the human; do not fill missing features with ungrounded UI simulation.
