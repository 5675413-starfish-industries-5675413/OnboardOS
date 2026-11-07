# 08 — Devpost draft (update after implementation)

## Project name

OnboardOS

## Tagline

Learn the job by doing the job.

## Elevator pitch (under 200 characters)

OnboardOS lets companies train new hires in realistic, connected workplaces where employees resolve cloud incidents, run AWS-backed tests, and submit evidence managers can review.

## About the project

### Inspiration

Employee onboarding often teaches software tools in isolation, even though actual work requires combining ticketing, messaging, documentation, cloud diagnostics, configuration changes, and human decisions. We wanted to create a workplace where a new hire can perform meaningful responsibilities safely before working in production.

### What it does

OnboardOS is an enterprise onboarding SaaS concept with three coordinated experiences: Organization Studio, Employee Workspace, and Manager Review. The intended flow is that an administrator configures a workplace, a manager assigns an incident, an employee investigates across connected simulated tools, saves a configuration, runs server-side tests, and submits a report. A manager reviews objective evidence and Bedrock-assisted commentary before approving or requesting revision.

For AWS × A10 Hack 2026, our target is the fictional Northstar Cloud scenario INC-104: a junior cloud engineer investigates a checkout API timeout.

### How we built it

**DRAFT — REPLACE THIS SECTION WITH ONLY VERIFIED IMPLEMENTATIONS.**

Our selected architecture is a React/TypeScript client, TypeScript API Lambda behind API Gateway, DynamoDB for role-scoped workplace state and evidence events, a dedicated Lambda runner for predefined deterministic tests, and Amazon Bedrock for scenario-aware language assistance and a structured draft evaluation. S3 is planned for larger artifacts and CloudWatch for actual backend observability. Cognito is preferred for authentication if the hackathon account allows it.

The core technical design separates AI narrative generation from actual test execution, and binds each result to the exact configuration revision that produced it.

### Challenges we faced

**DRAFT — REPLACE WITH TRUE EVENTS AFTER BUILD.**

The major design challenges are keeping multiple workplace surfaces consistent with a single state engine, enforcing tenant and manager/employee permissions, clearly separating synthetic diagnostic fixtures from real AWS execution evidence, and making AI feedback traceable to submitted artifacts.

### What we learned

**DRAFT — REPLACE WITH TRUE EXPERIENCES AFTER BUILD.**

We are exploring how a server-authoritative state machine, controlled tool adapters, and evidence-grounded AI can turn onboarding into practical, reviewable work instead of passive content.

### What's next

Longer term, OnboardOS could support role blueprints, reusable company-specific exercises, authorized integrations with collaboration and cloud tools, isolated real training environments, accessible session replay, and ongoing professional development. These are **future capabilities**, not hackathon claims.

## Built with — include only services actually used

Suggested tags: `aws`, `amazon-bedrock`, `aws-lambda`, `amazon-api-gateway`, `amazon-dynamodb`, `amazon-cloudwatch`, `amazon-s3`, `amazon-cognito`, `typescript`, `react`, `vite`, `nodejs`, `tailwindcss`, `shadcn-ui`, `monaco-editor`, `aws-sam`, `github`.

## Required links/media at submission

- GitHub repository link accessible to judges.
- All 2–6 team members attached to the project.
- Hosted site URL if functional.
- Screenshots, optional architecture slide, demo video (recommended).
- Explicitly state which evidence originates from real AWS calls and which training data are synthetic.

## Final pass before publishing

Convert plans to past-tense accomplishments **only for completed and verified code paths**; remove missing features, fix tech tags, replace generic learning/challenge text with real experiences, confirm team and links, submit before deadline.

Event: https://a10-x-aws-hack-26.devpost.com/
