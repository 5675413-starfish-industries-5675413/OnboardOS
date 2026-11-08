> **Architecture supersession notice (2026-11-07):** [14-architecture-freeze-v1.1.md](14-architecture-freeze-v1.1.md) is authoritative for final trust boundaries, worker design, API contracts and AWS Workshop gating. Older ADRs remain historical design context.

# 11 — Architecture decision register (ADRs)

| ADR | Choice | Rejected / deferred | Rationale | Review trigger |
|---|---|---|---|---|
| ADR-001 | One TypeScript monorepo with npm workspaces | Split frontend/backend repos | Shared contracts, fewer integration points | Team expands substantially |
| ADR-002 | React/Vite SPA | Next.js SSR | Workspace interaction dominates, simplify deployment | SEO/SSR becomes product requirement |
| ADR-003 | Modular monolith API Lambda + separate runner | Distributed microservices | Lower IAM/deploy overhead | Heavy independent workloads |
| ADR-004 | DynamoDB + S3 | Supabase/Postgres for MVP | Demonstrate AWS-native persistence | Relational complexity or enterprise analytics justify change |
| ADR-005 | AWS SAM infrastructure | Ad hoc console-only or sprawling Terraform modules | Reproducibility and explainability | Event IAM permissions block SAM |
| ADR-006 | Cognito + backend membership authorization | Global app role; frontend role switch | True identity and org-scoped permissions | Account restrictions require demo fallback |
| ADR-007 | Pure deterministic scenario engine | LLM as source of truth | Repeatability, testability, safety | None, core invariant |
| ADR-008 | Simulated app adapters + real bounded AWS runner | Full desktop/GitHub/Jira clones | Complete product path in 22 hours | Post-hackathon dedicated sandbox requirement |
| ADR-009 | Evidence-first manager review | Video-only AI scoring | Revision/test traceability, less invasive | User research shows visual replay necessary |
| ADR-010 | Bedrock review draft, then coworker | Multi-agent orchestration/fine-tuning | Concrete AI value with limited complexity | Validated labeled data, workload complexity |
| ADR-011 | Human final review | AI autonomous employment decision | Employment stakes and evidence uncertainty | Do not automate without independent validation/legal review |
| ADR-012 | One credible incident | Many thin scenarios | Completeness is more important than catalog | Golden path works ahead of schedule |
| ADR-013 | OnboardOS as temporary working brand | Commercial exclusive-name claim | Existing commercial name use found | Naming and trademark due diligence |
| ADR-014 | On-demand test execution with revision hash | UI generated fake success | Real AWS technical proof | Any implementation that cannot preserve exact revision |
| ADR-015 | 2026-11-07: Deterministic assignment/session ids (SHA-256 of org + scenario version + employee) with conditional writes | Random ids plus an idempotency-key ledger | Retries and double-clicks are idempotent by construction with no extra table; ids are opaque and are never a security control (every read re-checks ownership) | Multiple concurrent attempts per employee/scenario are needed |
| ADR-016 | 2026-11-07: `GSI2` holds a manager's assignments under sort-key prefix `ASSIGN#`; `REVIEWABLE#` stays reserved in the same partition | A third GSI; scanning | Uses the frozen index without a schema change; the review slice moves an item's `GSI2SK` to `REVIEWABLE#` when it becomes reviewable | Review-queue and assignment-list access patterns collide |
| ADR-017 | 2026-11-07: Manager read-only session preview deferred; manager/admin assignment lists show only assignments they created | Org-wide listing now | Org-wide listing needs an org-keyed index or a scan; neither is justified for the demo | Managers need to see their team's work without having created it |
| ADR-018 | 2026-11-07: Added `GET /v1/orgs/:orgId/assignable-employees` (single-partition Query on `ORG#<org>`) | Client-supplied employee ids found out-of-band | A manager needs to choose an assignee; the route returns only `userSub`, display name and teams, scoped by the server | Org size makes a bounded single-partition Query unsuitable |
| ADR-019 | 2026-11-07: Scenario content is served only by the API; `packages/scenario-fixtures` is server-only and the web app must not import it | Bundling fixtures into the SPA | Invariant 5: nothing hidden, and no synchronized-screen fakes; enforced by a source-boundary test and a bundle check | None |

Record changes with date, owner, reason, and impact on `contracts`, `API`, `tests`, `deployment` so agents do not silently diverge.
