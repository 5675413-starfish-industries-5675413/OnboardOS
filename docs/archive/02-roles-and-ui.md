> **Archived on 2026-11-08.** This file is an early planning note. It is not a description of the running product. The current overview is [the project README](../../README.md). The implemented AWS resources are in `infrastructure/template.yaml`.

# 02 — User roles, permissions, screens, and navigation

## Roles: organization-scoped

| Action | Org Admin | Team Manager | Employee |
|---|---|---|---|
| Create/edit organization, retention settings | Yes | No | No |
| Appoint/revoke managers | Yes | No | No |
| Manage scoped team roster | Yes | Assigned team (if enabled) | No |
| Edit role blueprint | Yes | Assigned team (if enabled) | No |
| Publish scenario version | Yes | Assigned team (if authorized) | No |
| Assign a scenario | Yes (scope checked) | Assigned employees | No |
| Open training session | Preview under demo isolation | Preview only | Own active session |
| Edit test artifact / run tests | Only preview copy | Only preview copy | Own active session |
| Submit assignment | No | No | Own session |
| View review evidence | Authorized organization scope | Own direct reports / assigned employees | Own submissions |
| Approve/reject/request revision | Authorized organization scope | Assigned employee | No |
| Override technical test status | **Never** | **Never** | **Never** |

`AI Coworker` is not an authenticated human actor; it cannot approve, create memberships, execute AWS tools, or alter test results.

## Auth pipeline

`Cognito or controlled demo auth → API Gateway auth → server resolves user → org membership + team scope → resource ownership → action permission → domain execution`.

Backend must return 401/403, never rely only on hidden UI buttons. A selected organization from a route is context, **not authorization proof**. Audit role changes, submissions, and manager decisions.

## Screen map

| Route | Screen | Principal user | Minimum supported actions |
|---|---|---|---|
| `/login` | Sign in | All | Log in and out; error handling |
| `/app` | Organization switcher | All | Choose authorized organization |
| `/org/:orgId/studio` | Organization Studio | Admin | See members/teams, select role blueprint, enable/disable permitted tool on new sessions |
| `/org/:orgId/manager` | Manager dashboard | Manager | See assigned people + review queue; create assignment |
| `/org/:orgId/employee` | Employee dashboard | Employee | See own assignments, start/resume |
| `/sessions/:sessionId` | Workplace shell | Employee | Ticket, team chat, logs, runbook, Monaco config editor, run tests, report, timeline |
| `/reviews/:submissionId` | Review workspace | Manager/admin | Evidence, diff, test results, AI draft, request revision/approve |

## UX principles

- Desktop-first, information-dense but legible: persistent sidebar, task context panel, application tabs, clear breadcrumb and status.
- One shared visual language: neutral dark/neutral light, one accent, semantic colors for verified passes/failures, not blanket colorful cards.
- Every action must have a loading, success, error, and locked/unauthorized state.
- Never overwrite unsaved Monaco drafts on tab navigation; distinguish `unsaved draft` from `saved revision`.
- The test result must visibly indicate `PASSED`, `FAILED`, `RUNNING`, `ERROR`, or `STALE`.
- Every claim on the review screen links to a stored artifact ID / event ID / test ID.
- Label initial diagnostic fixtures `Simulated incident data`; label subsequent test logs `Executed on AWS` only when backed by a real invocation.
- Use responsive fallback for phone screens but optimize actual work for laptop/desktop.
- Make focus handling, contrast, keyboard navigation, and structured status accessible.

## Primary workflow narratives

**Admin:** create or open Northstar Cloud → inspect Cloud Engineer blueprint → enable tool in role → save version → inspect configured manager and employee.

**Manager:** view team → create INC-104 assignment → employee receives it → manager sees status → inspect frozen submission/test/runbook/event evidence → approve or request revision with a reason.

**Employee:** open assignment → investigate ticket/logs/runbook/chat → save config revision → run test suite → inspect failure → revise → run again → write report → submit → read feedback.

No user is given external production AWS account permissions through OnboardOS.
