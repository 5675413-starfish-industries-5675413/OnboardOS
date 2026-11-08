> **Archived on 2026-11-08.** This file is an early planning note. It is not a description of the running product. The current overview is [the project README](../../README.md). The implemented AWS resources are in `infrastructure/template.yaml`.

# 09 — From hackathon prototype to an enterprise SaaS product

## Stage 0 — Hackathon proof

One fictional AWS-based organization, one junior cloud engineer role, one incident, multiple **OnboardOS-built simulated** interfaces, one real AWS-backed runner, Bedrock review draft, and manager-controlled final review. No production AWS credentials to the employee. Persistent evidence and backend authorization.

**Not** equivalent to a fully isolated customer's cloud account or a complete digital twin of any real AWS employee role.

## Stage 1 — Commercial pilot: engineering onboarding

Start with one narrow buyer segment: engineering enablement teams onboarding software/cloud engineers. Deliver versioned role blueprints, limited scenario authoring, safe real training environments for supported tools, manager cohorts, scoped evidence access, audit logs, retention policies, and performance/reliability evaluation from real pilot data.

Pilot hypotheses:
- Faster time to demonstrated proficiency on a validated task (not just faster course completion).
- Lower manager coaching hours for repetitive basic scenarios.
- Better consistency of feedback across reviewers.
- Enough repeated usage per employee and new cohort to justify an annual subscription.

No savings or readiness scores should be asserted without measurements against a baseline.

## Stage 2 — Enterprise platform

- Real identity federation (OIDC/SAML), user lifecycle (SCIM), MFA enforcement.
- Dedicated tenant resource isolation where needed; VPC/account-level separation for hands-on cloud exercises.
- Approved adapters: GitHub Apps, Slack sandboxes, Jira/Confluence, CloudWatch, observability and issue systems. Integration permissions limited to explicit training environments and tested for cross-tenant isolation.
- Sandboxed code execution using isolated build runners; no general public user code running in application Lambda.
- Reusable scenario authoring with publication review, staff-only grader, fixtures, reproducible reset.
- Consent-based authorized session replay with masking and retention.
- Billing (annual platform + active trainees/usage), usage cost attribution, quotas, support/SLA.
- Data protection, retention/deletion, legal and HR assessment requirements, independent security testing, accessibility and fairness validation.

## Stage 3 — Generalizable role engine

Transfer common primitives (actors, artifacts, permitted actions, events, review) to cybersecurity operations, software engineering, and customer operations. Each role needs domain-specific simulated systems, expert-designed objectives, and scientifically validated evaluation. Do not claim a generic prompt can reliably recreate arbitrary company workflows.

## Commercial competitive position and caveats

Hands-on lab providers, virtual work simulations, and assessment vendors already serve adjacent segments. The intended differentiation must be tested with buyers: **multi-tool continuous job practice**, company-specific context, revision-bound technical evidence, and human managerial review. Pricing, retention, and willingness to switch are not yet validated.

## Naming due diligence

The name OnboardOS is already used publicly for corporate banking onboarding and at least one additional client onboarding product. It remains a hackathon placeholder until trademark, domain, and commercial naming checks. Do not describe it as available or exclusive.
