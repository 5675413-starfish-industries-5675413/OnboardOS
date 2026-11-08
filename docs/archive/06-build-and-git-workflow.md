> **Archived on 2026-11-08.** This file is an early planning note. It is not a description of the running product. The current overview is [the project README](../../README.md). The implemented AWS resources are in `infrastructure/template.yaml`.

# 06 — Step-by-step implementation, repository setup, collaboration, and AWS deployment

## Start from a new repository

Proposed name `onboardos-aws-hack-2026`. Respect organizer requirements on start times and prebuilt code; imported planning docs can be distinguished from submitted implementation history.

### Preflight

- Team (official 2–6 participants) agrees on track, owner roles, public/private repo policy, secrets handling.
- Verify tools are installed: `git`, GitHub CLI (`gh` optional), compatible Node/npm, AWS CLI, AWS SAM CLI if allowed.
- Make sure a team member can deploy a trivial Lambda and invoke a permitted Bedrock model **before** writing complex AWS-dependent code.
- Confirm whether team has a supported Cognito/AppSync/SAM path. Default to Cognito + API Gateway + Lambda.

### Local bootstrap command order

```bash
mkdir onboardos-aws-hack-2026
cd onboardos-aws-hack-2026
git init -b main
npm init -y
npm create vite@latest apps/web -- --template react-ts
# Create package manifests for services/api, services/test-runner,
# packages/contracts, packages/scenario-engine, packages/scenario-fixtures.
# Configure root npm workspaces, then install from root.
npm install
```

Use root `package-lock.json` and npm workspaces; pin Node.js major version to match deployment, preferably 24 where supported. Root npm scripts after implementation: `dev`, `typecheck`, `lint`, `test`, `build`, `verify` (typecheck+lint+test+build). Do not add a `verify` command that claims to have verified missing parts.

### Target directory structure

```text
onboardos-aws-hack-2026/
├── apps/web/src/
│   ├── app/                 # router, providers, session context
│   ├── layouts/             # app shell, workplace shell
│   ├── features/            # auth, org, manager, employee, incident, chat,
│   │                        # diagnostics, editor, tests, submissions, reviews
│   ├── components/ui/       # shadcn primitives
│   └── lib/                 # API client, query config, typed errors
├── services/api/src/
│   ├── handler.ts           # API routing
│   ├── middleware/          # identity, authz, request validation
│   ├── domain/              # organizations, assignments, session, review
│   ├── storage/             # DynamoDB/S3 data access
│   ├── adapters/            # mock chat/ticket, real bounded test service
│   └── ai/                  # Bedrock coworker and evaluator
├── services/test-runner/src/
│   ├── handler.ts           # predefined suites only
│   └── suites/              # NEVER imported into apps/web
├── packages/contracts/src/ # frontend-safe Zod schemas/types
├── packages/scenario-engine/src/ # pure state transition logic
├── packages/scenario-fixtures/src/ # ONLY employee-safe fixtures
├── infrastructure/template.yaml
├── scripts/seed-demo.ts
├── docs/
├── .github/workflows/verify.yml
├── .env.example
├── .gitignore
├── CLAUDE.md
└── README.md
```

**Critical:** Keep hidden private test suites out of packages consumed by the web app. `packages/contracts` must not contain staff-only rubrics/solutions.

### GitHub workflow

```bash
git status
git add .
git commit -m "chore: bootstrap OnboardOS"
gh repo create onboardos-aws-hack-2026 --private --source=. --remote=origin --push

git switch -c feat/scenario-engine
# Work only in owned files, run relevant tests.
npm run verify
git add .
git commit -m "feat: add deterministic scenario transitions"
git push -u origin feat/scenario-engine
# Open PR against main; review checks; merge, then pull main.
```

Only call something `deployed` if its commit is on `main` **and** the hosted environment has been deployed from that version. Use one designated deployment owner; no competing SAM deployments.

### GitHub rules

- Minimum one check on PR/push: `npm ci && npm run verify` once package scripts exist.
- Never commit `.env`, AWS credential/config files, public/private keys, recordings, or real company information.
- Require human inspection of AI agent edits; agents must report files changed and tests run.
- Scope feature PRs to subdirectories and documented API contracts; avoid large concurrent changes to root package manifests.
- Keep `docs/decisions.md` or ADR current for architecture changes.

## Implementation order: vertical slice gates

**Gate 0 — AWS permissions:** CLI identity, successful model invocation, ability to deploy required resources.

**Gate 1 — Local logic:** contracts + pure scenario engine; test 800ms failure, 1800ms pass, 5000ms invalid, stale evidence after revision.

**Gate 2 — Cloud foundation:** HTTP API + API Lambda + DynamoDB + one health route; browser→AWS API→DB→browser works.

**Gate 3 — Accounts:** Cognito real identities (or documented server-authenticated demo fallback); seed company/team/memberships; negative authorization tests.

**Gate 4 — Manager assignment:** manager creates assignment; employee sees it and can start session; state persists after refresh.

**Gate 5 — Actual execution:** employee edits supported config; actual test-runner Lambda invoked; results recorded and revision-bound.

**Gate 6 — Evidence and submission:** timeline, frozen report, manager review queue, approve or request revision.

**Gate 7 — Bedrock:** working model inference on submitted evidence; no fake success when inference fails; coworker optional after evaluator.

**Gate 8 — Live deployment:** production-demo frontend + backend, two clean-slate end-to-end passes, screenshots, recorded demo, Devpost.

Build in this order. If behind schedule, cut decorative org dashboards, additional scenarios, full recording, external OAuth; keep gates 4–8.

## Deployment commands (only after configuring actual SAM resources)

```bash
aws sts get-caller-identity
aws configure list
aws bedrock list-foundation-models --region "$AWS_REGION"
# Listing models does not prove invoke permission: run a real minimal inference.
sam validate --template-file infrastructure/template.yaml
sam build --template-file infrastructure/template.yaml
sam deploy --guided --template-file .aws-sam/build/template.yaml
```

Adapt SAM syntax if stack/resource packaging requires different relative paths. Never paste temporary AWS secrets into prompts, logs, repo, or public screenshots. If IAM/CloudFormation permissions block deployment, ask the on-site AWS mentor and document any authorized fallback.

## Repo ownership (three-person example)

- Developer A: frontend workspace + role-specific UI.
- Developer B: SAM/AWS, DynamoDB, permissions, scenario engine.
- Developer C: Bedrock review, acceptance tests, integration QA, Devpost.

Two-person fallback: reduce org studio and coworker chat first; use one main integration driver and one QA owner. Everyone must understand AWS service choices and architecture for judging.
