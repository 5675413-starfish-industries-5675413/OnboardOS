# 00 — Product requirement document

## Identity

- Product: **OnboardOS** (working hackathon brand; commercial naming clearance incomplete)
- Tagline: **Learn the job by doing the job.**
- Market: B2B engineering enablement and technical onboarding
- Buyer hypothesis: engineering enablement manager, platform engineering leader, or learning-and-development sponsor
- End users: organization administrator, team manager, new engineer
- Promise: company-specific work practice with concrete, inspectable outputs rather than passive lessons

## Problem and hypothesis

New engineers must learn a combined workflow: tickets, messages, runbooks, cloud diagnostics, code/configurations, tests, escalation, and written communication. A standalone course or toy coding test doesn't reproduce their interactions. We hypothesize a connected simulation plus evidence-backed human review can help managers supervise practical onboarding more consistently. This benefit is **not yet experimentally validated**.

Competitors already offer hands-on labs and skill assessment; do not claim that OnboardOS invents sandboxes, AI grading, or job simulations. Candidate product differentiation: company-specific, **cross-tool continuity**, constrained real execution, and reviewable history across a multi-assignment workplace.

## Demo user story / exact end-to-end vertical slice

1. Org administrator sees a configured fictional company `Northstar Cloud`, a Cloud Engineering team, an assigned manager, and a Cloud Engineer blueprint. Toggles at least one workplace tool option and sees its effect on **new** sessions.
2. Manager selects employee and assigns published scenario **INC-104**.
3. Employee opens assignment, loads an isolated simulated workplace with ticket, team messages, runbook, synthetic diagnostics, and a JSON service configuration editor.
4. Employee investigates, asks the Bedrock-powered fictional platform lead for help, edits configuration, saves revision, and triggers a real AWS Lambda test runner.
5. Initial configuration fails; a valid repair changes test results. Every result is bound to a revision hash, suite version, and execution ID. Editing after a pass makes evidence stale.
6. Employee submits a structured incident report. Backend freezes artifact and evidence references.
7. Bedrock creates a **draft** grounded in frozen evidence. The manager inspects it, may disagree, and approves or requests revision. No automated employment decision.
8. App persists state across reloads. Authorization prevents employees accessing manager-only review, and prevents cross-employee access.

## P0 scope — complete hackathon product

- One seeded organization, one team, three real authenticated identities (or server-enforced controlled demo sessions if Cognito unavailable).
- Roles and backend-enforced authorization.
- One published scenario, manager assignment, employee dashboard, manager queue.
- One session with stateful tools: ticket, messages, runbook, synthetic logs, editor, test runner, report.
- One real AWS-backed deterministic test invocation.
- Immutable submissions, timestamped event history, review decision.
- One functioning Bedrock path: prefer **review draft**, then coworker if time permits.
- Hosted demo, technical README, test evidence, Devpost materials.

## P1 differentiation / stretch

- Bedrock coworker in Team Chat using employee-visible facts only.
- Working blueprint toggle (disabled chat disappears **and** backend disallows its action for new sessions).
- Session reset creating a new attempt; earlier submissions not erased.
- Stronger two-parameter incident optimization with timeout and retry constraints.
- Optional scenario fork after initial completion.

## Explicit exclusions

No arbitrary untrusted code execution; unrestricted cloud console; true remote desktop; live employee surveillance; direct Slack/Jira/GitHub OAuth; enterprise SSO; customer data import; billing; universal scenario generator; fine-tuning; hiring readiness score; unlimited multi-tenant provisioning.

## Quality bar

- Server-side state changes observable in *both* employee and manager views.
- Evidence remains consistent after refresh; no fake green states.
- All test and AI calls have explicit success/error/timeout states.
- UI looks and feels like credible engineering software, not a game.
- Human manager remains final decision-maker.
- The product must remain usable when Bedrock inference fails (AI review may be marked unavailable).
