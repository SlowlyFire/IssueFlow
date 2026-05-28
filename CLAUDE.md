# CLAUDE.md — IssueFlow Project Memory

This file is read by Claude Code at the start of every session. It encodes the
non-negotiable rules, architecture decisions, and pitfalls for this project.
**Read it fully before writing any code.**

---

## What this project is

A RESTful backend for **IssueFlow**, a lightweight Jira-style ticket tracker.
It is a 36-hour take-home assignment for AT&T's TDP 2026 program. A **human
reviewer** clones the repo, runs it, reads the code and tests, and reads
`prompts.md`. There is no autograder. Optimize for: (1) it runs in <5 min on a
clean clone, (2) clean, idiomatic, readable code, (3) tests that prove the
hard business rules work, (4) honest docs.

## Stack (do not deviate)

- **NestJS 10** (the skeleton is on `^10.0.0` — NOT 11, despite the PDF). Any
  package you add must be compatible with Nest 10.
- **TypeScript 5.x**, **TypeORM 0.3.x**, **PostgreSQL** (via the provided `compose.yml`).
- Auth stack: `@nestjs/jwt@^10`, `@nestjs/passport@^10`, `passport`,
  `passport-jwt@^4`, `bcrypt`. Scheduler: `@nestjs/schedule@^4`.
- Tests: **Jest** (unit, `*.spec.ts`) + **Supertest** (e2e, `test/`).
- CSV: `csv-parse` and `csv-stringify` are already in package.json — use them.

## The contract is README.md

The skeleton's `README.md` API table is the **implementation contract**. When
the README and the PDF disagree, **the README wins**. Known specifics to honor
exactly:

- User update is `POST /users/update/:userId` (NOT PATCH).
- Audit logs endpoint is `GET /audit-logs` with optional query filters
  `entityType`, `entityId`, `action`, `actor`.
- Comment responses embed `mentionedUsers: [{ id, username, fullName }]`.
- Mentions endpoint is `GET /users/:userId/mentions`, paginated, newest first,
  returns `{ data, total, page }`.
- All success responses are `200 OK` (the contract does not use 201).
- Project update is `PATCH /projects/:projectId`. Ticket update is `PATCH /tickets/:ticketId`.

## Decisions already made (do not re-litigate)

1. **Password**: `POST /users` accepts a `password` field (hashed with bcrypt),
   even though the README example omits it — login requires a password, so users
   need one. Document this in run.md.
2. **Soft delete** uses TypeORM `@DeleteDateColumn` (`deletedAt`). Standard
   queries hide deleted rows automatically; admin "deleted" endpoints use
   `withDeleted: true` + filter to non-null `deletedAt`.
3. **Optimistic locking** uses TypeORM `@VersionColumn` on Ticket and Comment.
   Concurrent update → catch the version mismatch → throw 409 Conflict.
4. **Audit logging** is done via an injected `AuditService.record(...)` called
   explicitly inside each state-changing service method. NOT via an interceptor
   (we need clean before/after data and a SYSTEM actor for auto-assign).
5. **Single `main` branch.** Commit frequently with clear messages. No CI gating.

## Module layout

```
src/
  auth/         JWT login/logout/me, JwtStrategy, JwtAuthGuard, token deny-list, RolesGuard
  users/        CRUD + GET /users/:id/mentions
  projects/     CRUD + soft-delete + GET /:id/workload
  tickets/      CRUD + state machine + dependencies + export/import + soft-delete + restore
  comments/     CRUD + mention parsing/persistence
  attachments/  upload/download with MIME + size validation
  audit/        AuditService (exported, injected widely) + GET /audit-logs
  scheduler/    @Cron escalation job
  common/       guards, exception filter, decorators, enums, base DTOs
  database/     TypeORM datasource config
```

## Hard business rules (these are what the reviewer tests)

### Ticket status state machine
- Allowed forward path ONLY: `TODO → IN_PROGRESS → IN_REVIEW → DONE`.
- Backward transitions are rejected (400).
- A ticket that is `DONE` is **frozen** — no field may be updated (400/409).
- A ticket cannot transition to `DONE` if it has any dependency (blocker) that
  is not itself `DONE`.

### Enums (validate strictly, reject anything else)
- status: `TODO | IN_PROGRESS | IN_REVIEW | DONE`
- priority: `LOW | MEDIUM | HIGH | CRITICAL`
- type: `BUG | FEATURE | TECHNICAL`
- role: `ADMIN | DEVELOPER`

### Mentions (3.6)
- Parse `@username` from comment content, case-insensitive match against users.
- Unknown @names are ignored (not an error).
- On comment update, **diff** the mention set: add new, remove gone. Do not
  blindly re-insert.

### Escalation scheduler (3.7)
- Cron job. For each overdue ticket (dueDate passed) with priority < CRITICAL:
  promote one level LOW→MEDIUM→HIGH→CRITICAL.
- At CRITICAL and still overdue: set `isOverdue = true`. Never escalate beyond
  CRITICAL (idempotent).
- Only applies if dueDate is set. Does NOT change status.
- Manual priority change via PATCH resets escalation state (`isOverdue` cleared,
  re-evaluate next cycle from the new priority).
- Each escalation writes an audit log entry.

### Auto-assignment (3.8)
- On ticket CREATE only (never on update), if `assigneeId` is absent: pick the
  DEVELOPER in the project with the lowest count of non-DONE tickets in that
  project. Tie-break: oldest registrant (lowest user id / earliest createdAt).
- ADMINs are never auto-assign candidates.
- No developers linked → `assigneeId = null`, no error.
- Auto-assign writes an audit entry with `actor = SYSTEM`, `action = AUTO_ASSIGN`.

### Dependencies (3.2)
- `POST /tickets/:id/dependencies { "blockedBy": 42 }` → this ticket is blocked by 42.
- Both tickets must exist and be in the same project (else 400).
- Interacts with the DONE rule above.

### Attachments (3.3)
- Max 10 MB; reject larger (400).
- Allowed MIME: `image/png`, `image/jpeg`, `application/pdf`, `text/plain`. Reject others (400).

### CSV export/import (3.4)
- Export fields: id, title, description, status, priority, type, assigneeId.
- Import is multipart with a `projectId` form field; returns
  `{ created, failed, errors: [...] }`.
- MUST correctly handle commas and quotes inside field values — use the
  csv-parse/csv-stringify libs, never hand-rolled split(',').

## Error handling & validation

- Global `ValidationPipe` with `whitelist: true, forbidNonWhitelisted: true,
  transform: true`. Reject unknown/invalid fields.
- A global exception filter returns a consistent shape:
  `{ statusCode, message, error, timestamp, path }`.
- Every "not found" is a real 404 with an informative message. Every rule
  violation is a 400/409 with a message that says WHAT rule was broken.

## Testing rules

- Before implementing the state machine or escalation logic, write the unit
  tests FIRST (TDD). These are the rules most likely to have bugs.
- Prioritize: state machine, mention diffing, escalation transitions +
  idempotency, workload tie-breaking, optimistic-lock 409, CSV
  comma/quote roundtrip, attachment rejections, soft-delete hide/restore.
- e2e: one full happy-path lifecycle + auth 401 path.
- Don't chase coverage %. ~20 meaningful tests beat 200 shallow ones.

## Workflow rules for Claude Code

- **Explain before committing.** After each feature, summarize what you built
  and why, in plain language, so the human can verify understanding (they are
  accountable for this code in an interview).
- **Small commits** with clear messages, one logical change each.
- At the end of each session, append a summary to `docs/session-log.md`:
  what was built, key decisions, files touched, what to do next.
- Never invent endpoints not in the README contract.
- Never hard-delete tickets or projects.
- If a requirement is ambiguous, state the assumption you're making in a code
  comment AND in the session log, then proceed — don't stall.
- Keep `.env` out of git; provide `.env.example`.
