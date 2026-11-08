> **Live-demo note (2026-11-08).** The public site is an earlier deployment. It can show assignment, investigation, Lambda test results, submission, and manager review. It does not include the Bedrock review draft or the AI coworker. Do not present those as part of the live walkthrough.

# 12 — Demonstration script and judge questions

## One sentence

OnboardOS lets a new cloud engineer practice realistic multi-tool work in a controlled environment, produce genuine technical evidence, and receive manager-reviewed feedback before touching production.

## Recommended ~2-minute screen demonstration

**00:00–00:15** Product and buyer: company-specific practical employee onboarding rather than passive lessons.

**00:15–00:30** Manager: show assignment created for junior cloud engineer at fictional Northstar Cloud; mention roles and authorization.

**00:30–00:50** Employee: ticket, team conversation, synthetic diagnostics, runbook all refer to same incident and state.

**00:50–01:15** Config and AWS: show original 800ms config test failing from genuine Lambda runner, adjust to 1800ms and show actual pass with revision hash and execution reference.

**01:15–01:35** Evidence: submit an incident report, show frozen artifact, action timeline, deterministic results, and Bedrock-generated draft referencing actual evidence.

**01:35–01:50** Manager: inspect submission, approve or request revision; human final authority.

**01:50–02:00** Scale thesis: role blueprints and safely connected sandboxes could eventually extend beyond cloud engineering.

## Technical explanations to know

- **Why Lambda?** Separate stateless API operations from bounded deterministic scenario test execution; actual AWS evidence.
- **Why DynamoDB?** Session/assignment records and append-only action events, conditional version checks.
- **Why Bedrock?** Grounded communication and review drafts; never judge test success or permissions.
- **Why not full AWS console?** Enterprise tool access would require isolated accounts, permissions, quotas, and lifecycle control; this demo models a bounded real workflow rather than imitating Amazon internals.
- **Why manager review?** AI can summarize data but is not authoritative over employment readiness.
- **How is it different from labs?** Hypothesis: persistent company-specific cross-tool workflow and granular revision-linked managerial evidence; competition exists and distinctiveness must be validated.
- **What is actually simulated?** Incident logs, ticket, coworkers, runbooks. **What is real?** API, stored state, Lambda test-runner invocations, Bedrock inference if demonstrated.
- **What about security?** Org-scoped backend permissions, least privilege runner, synthetic data, no user AWS keys, no arbitrary code.

## Submission claims audit

Before recording, identify each claim and provide concrete screen or log evidence. Don't advertise browser replay, live Slack/Jira integration, production AWS account provisioning, multi-tenant maturity, or automatic readiness scoring unless truly implemented and validated.
