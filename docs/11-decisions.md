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

Record changes with date, owner, reason, and impact on `contracts`, `API`, `tests`, `deployment` so agents do not silently diverge.
