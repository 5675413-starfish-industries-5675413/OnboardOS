> **Architecture Freeze v1.1:** Before deploying any AWS service, read [the authoritative architecture](docs/14-architecture-freeze-v1.1.md) and [AWS service provisioning gates](docs/15-aws-provisioning-order.md). Earlier documentation is supporting context; where choices differ, v1.1 governs.

# OnboardOS — AWS Hackathon Build Pack

**Tagline:** Learn the job by doing the job.

**Status:** Planning / repository-ready specification. **This package is not a deployed or completed SaaS app.**

OnboardOS is an enterprise workplace simulation platform. An organization configures training; a manager assigns practical work; an employee works across interconnected simulated tools, runs deterministic tests on AWS, and submits artifacts; a manager reviews evidence with Bedrock-assisted commentary.

## Hackathon demo contract

**Northstar Cloud** (fictional company) → **Junior Cloud Platform Engineer** → **INC-104** cloud-service incident.

`Admin setup → Manager assignment → Employee investigation → Config revisions → AWS test runner → Evidence → Submission → Bedrock draft → Human review`.

This pack reorganizes the earlier JobOS architecture and renames it OnboardOS. It adds explicit release gates, secure boundaries, implementation priorities, and a Devpost draft.

## Read in order

1. [Product and scope](docs/00-product-and-scope.md)
2. [Architecture and AWS decisions](docs/01-architecture-and-aws.md)
3. [Roles, permissions, and UI](docs/02-roles-and-ui.md)
4. [Scenario engine and executable incident](docs/03-scenario-engine.md)
5. [Data model and API](docs/04-data-and-api.md)
6. [AI, evaluation, and evidence](docs/05-ai-and-evidence.md)
7. [Implementation runbook and GitHub workflow](docs/06-build-and-git-workflow.md)
8. [Verification and release criteria](docs/07-verification-and-release.md)
9. [Devpost draft](docs/08-devpost-draft.md)
10. [Enterprise roadmap](docs/09-enterprise-roadmap.md)
11. [Backlog and milestones](docs/10-backlog.md)
12. [Architecture decision record](docs/11-decisions.md)
13. [Demo script](docs/12-demo-script.md)
14. [Coding-agent rules](CLAUDE.md)
15. [First coding-agent session prompt](docs/13-first-coding-session-prompt.md)
16. [Landing page design brief](docs/16-landing-page-design-brief.md)

## Important constraints

- No real AWS employee data, private internal Amazon tools, unrestricted AWS IAM access, or production integrations in the demo.
- User activity is captured **inside the authorized training product**; do not record unrelated desktop activity.
- An LLM never sets test-pass status or managerial approval.
- A passed test is valid for **only** the exact tested artifact revision and test-suite version.
- Every request checks identity, tenant, role, resource ownership, and action permissions server-side.
- Before making claims in Devpost, replace future tense with verified implemented behavior and document omissions.
- **Naming risk:** at least one existing external company already operates under OnboardOS. Treat OnboardOS as a hackathon working name until commercial clearance.

## Required competition information

- AWS × A10 Hack 2026, November 7–8.
- Team: 2–6 eligible members.
- Submission deadline: November 8, 2026, 9:00 AM PST.
- Devpost requires a Git repository URL and every teammate added to the project. A demo video/screenshots/logo are recommended.
- Rules: https://a10-x-aws-hack-26.devpost.com/rules
- Devpost: https://a10-x-aws-hack-26.devpost.com/

## Repo establishment

Create a NEW GitHub repository named `onboardos-aws-hack-2026` when authorized to implement. Copy these planning docs into it, then scaffold TypeScript npm workspaces and implement the code in the order in the build runbook. **Do not claim these docs are an already-working repository.**

## Product maturity vocabulary

- **Planned:** documented only.
- **Implemented locally:** source code works locally; evidence recorded.
- **Deployed:** verified running against AWS resources.
- **Demo-ready:** complete path proven against deployed resources and role boundaries.
- **Enterprise-ready:** separate security, privacy, resilience, integration, accessibility, and commercial acceptance process (not a hackathon claim).
