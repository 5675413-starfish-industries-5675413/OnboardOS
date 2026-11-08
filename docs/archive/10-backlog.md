> **Archived on 2026-11-08.** This file is an early planning note. It is not a description of the running product. The current overview is [the project README](../../README.md). The implemented AWS resources are in `infrastructure/template.yaml`.

# 10 — GitHub issues, ownership, dependency order, and timeboxes

Prefix issue titles with `ONB-`. Assign owner and verify file ownership before dispatching coding agents. Timeboxes below are relative to authorized development start (H0) and are **priorities**, not guaranteed delivery estimates.

| ID | Priority | Deliverable | Depends on | Acceptance evidence |
|---|---|---|---|---|
| ONB-01 | P0 | Fresh TypeScript npm-workspaces repo, GitHub main, CI scripts | None | `npm run verify` passes once configured; GitHub remote verified |
| ONB-02 | P0 | AWS proof: identity, minimal API, DynamoDB, test runner, real Bedrock invocation | ONB-01 | Real AWS request IDs and CloudWatch log records |
| ONB-03 | P0 | Shared contracts and INC-104 fixture | ONB-01 | Zod/types compile; fixture client-safe |
| ONB-04 | P0 | Pure scenario engine with state machine, revision/hash logic | ONB-03 | Unit tests for transitions and stale evidence |
| ONB-05 | P0 | Real authentication and membership authorization | ONB-02 | Cross-role denied via API, not only UI |
| ONB-06 | P0 | Role shells, organization, manager, employee dashboards | ONB-03, ONB-05 | Role-specific screens load authorized real data |
| ONB-07 | P0 | Assignment creation + session persistence | ONB-04, ONB-05 | Manager assignment appears on employee account after refresh |
| ONB-08 | P0 | Employee incident, docs, diagnostics, configuration editing | ONB-07 | Saved config revision persists; no hidden test leaked |
| ONB-09 | P0 | Dedicated predefined AWS Lambda test runner and event evidence | ONB-02, ONB-08 | 800 fails, 1800 passes, 5000 rejected; runner real invocation |
| ONB-10 | P0 | Submission freezing and manager review | ONB-07, ONB-09 | Manager sees exact artifacts; approve/revision persists |
| ONB-11 | P0 | Bedrock evidence-grounded evaluation draft | ONB-10, ONB-02 | Real inference, validated evidence refs or explicit unavailable |
| ONB-12 | P0 | Hosted demo, integration tests, README, screenshots, Devpost | All core | Two golden-path runs; final URLs and team confirmed |
| ONB-13 | P1 | Bedrock contextual coworker | ONB-02, ONB-08 | Response references permitted scenario facts; no secret context |
| ONB-14 | P1 | Blueprint tool toggle affects **new** sessions | ONB-06, ONB-07 | Disabled tool blocked both UI and backend |
| ONB-15 | P2 | Replay using rrweb | ONB-10 | Consent/masking/restricted playback demonstrated |
| ONB-16 | P2 | External sandbox OAuth integrations | Post-hackathon | Design only, do not start during hackathon |

## 22-hour target schedule

| Hacking elapsed | Primary integration target | Gate |
|---|---|---|
| H0–H2 | Repo, AWS identity, first Bedrock/model + API experiments | Actual AWS access established |
| H2–H5 | Shared contracts, scenario engine, minimal hosted backend | Backend round trip and pure tests pass |
| H5–H9 | Auth + role shells + assignments + employee scenario | Assignment persists and loads |
| H9–H13 | Config revision, deterministic runner, evidence | Correct failure/pass observed on AWS |
| H13–H16 | Submit/review + Bedrock draft | Human decision persists |
| H16–H19 | Integration, adversarial auth, polish | Golden path passes twice |
| H19–H22 | Video, README, final deploy/tag, Devpost | Submission accepted **before** deadline |

Official deadline: Sun Nov 8, 2026 at 9:00 AM PST. Shift timeline if the actual hacking start differs; do not use this chart to justify missing the cutoff.

## Hard cuts when behind

Cut P2 and P1 first. Keep single role and incident. Cut invitation flows, custom scenario generation, fake Slack/GitHub OAuth, screen recording, CI/CD automation complexity, design polish beyond functional clarity. **Never** cut backend authorization, the real test runner, frozen evidence, or manager decision if still presenting the complete OnboardOS claim.

## Ownership suggestions

2 developers: A frontend/UI + Devpost; B AWS/API + engine + evaluation; both test. 3 developers: A UI/UX, B AWS/state/security, C Bedrock/integration/QA. Deployment rights and resource naming owned by one designated individual; integrate feature branches daily/hourly rather than keeping unmerged work to deadline.
