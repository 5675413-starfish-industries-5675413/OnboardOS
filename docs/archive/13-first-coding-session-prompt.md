> **Archived on 2026-11-08.** This file is an early planning note. It is not a description of the running product. The current overview is [the project README](../../README.md). The implemented AWS resources are in `infrastructure/template.yaml`.

# 13 — First coding-agent session prompt

Copy this into Claude Code, Kiro, or your chosen coding agent **after cloning/creating the new OnboardOS repository**. The agent must inspect actual files and follow organizer rules rather than assuming infrastructure exists.

---

You are the lead implementation engineer for **OnboardOS**, an AWS × A10 2026 hackathon project. The project is a full-stack enterprise onboarding simulator. Read the repo `README.md`, `CLAUDE.md`, and `docs/00` through `docs/07` before implementing. Treat docs as design intent, not evidence that any code exists.

## Task for this session (Phase 0 only)

1. Inspect `pwd`, `git status`, current branch, root files, available tool versions, and package manifests. Report exact findings.
2. Establish a new **npm workspaces** TypeScript monorepo with React + Vite in `apps/web`, AWS Lambda API and test-runner packages, `packages/contracts`, `packages/scenario-engine`, and employee-visible `packages/scenario-fixtures`.
3. Configure pinned Node version, shared tsconfig, root scripts (`dev`, `typecheck`, `lint`, `test`, `build`, `verify`), Git ignore, ESLint, Vitest, and a basic GitHub Actions verification workflow. Avoid heavyweight dependency additions.
4. Implement a polished but minimal OnboardOS role landing shell with *clearly labeled stub panels*; **do not claim** fake enterprise actions are live.
5. Implement typed Zod contracts for one versioned INC-104 scenario, identity-safe session state, configuration, event, and test results. No hidden expected answers or test suite inside the web bundle.
6. Build the **pure deterministic** scenario engine for saving a config revision and marking previously passed test evidence stale when the config changes. Add independent unit tests. Keep AWS calls out of the engine.
7. Document what AWS access is needed for the next phase. If organizer AWS credentials are already configured, safely verify the caller identity and accessible services, **without printing secrets**. Do not deploy unsupported services or create payment instruments.
8. Run all local checks and report: changed files, actual commands/tests/results, branch/commit status, AWS resources created (if any), and one concrete next step.

## Nonnegotiable constraints

- Do not build a fake success path, fabricate Lambda/Bedrock responses, or silently swap to a new architecture.
- Enforce separation of client-safe fixtures from private tests.
- Frontend never decides permissions or test-pass results.
- No direct AWS credentials in browser.
- Keep modifications within Phase 0; do not launch coding agents against unrelated modules or make several overlapping changes simultaneously.
- If something cannot be verified, label it `UNVERIFIED` and preserve the repo in a valid state.
- Propose any additional AWS service **only** with a specific necessity, setup cost, and fallback.

## Next phase, only after a reviewed local baseline

Prove an actual HTTP API → Lambda → DynamoDB round trip; configure Cognito or a permission-enforcing authorized fallback; deploy a bounded test-runner Lambda and demonstrate a genuine failed 800ms fixture and passed 1800ms fixture. Then continue with assignments, submissions, manager review, and Bedrock.

---

Do **not** claim the hackathon is ready until both local checks and the complete deployed manager→employee→test→submission→review path have been verified.
