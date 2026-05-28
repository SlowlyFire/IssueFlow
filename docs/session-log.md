# Session Log

## Session 0 — Bootstrap (2026-05-28)

**Goal:** clean, running NestJS 10 foundation. No features yet.

### Changed
- `package.json` — added deps (all NestJS 10-compatible):
  - runtime: `@nestjs/jwt@^10`, `@nestjs/passport@^10`, `passport`,
    `passport-jwt@^4`, `bcrypt`, `@nestjs/schedule@^4`, `@nestjs/config`
  - dev: `@types/passport-jwt`, `@types/bcrypt`
  - Verified `npm ls @nestjs/common @nestjs/core` → every package dedupes to
    `@nestjs/common@10.4.22` / `@nestjs/core@10.4.22`. No Nest 11 anywhere.
- `.env` (gitignored) and `.env.example` (committed) — DB vars matching
  `compose.yml`, `JWT_SECRET`, `JWT_EXPIRES_IN=3600`, `PORT=3000`.
- `src/app.module.ts` — wires `ConfigModule.forRoot({ isGlobal: true })`,
  `TypeOrmModule.forRootAsync` (reads DB vars from env, `synchronize: true`,
  `autoLoadEntities: true`), `ScheduleModule.forRoot()`, and the 8 empty
  feature modules.
- `src/main.ts` — global `ValidationPipe({ whitelist, forbidNonWhitelisted,
  transform })`, global `AllExceptionsFilter`, listens on `PORT` from env.
- `src/common/all-exceptions.filter.ts` — `@Catch()` filter returning
  `{ statusCode, message, error, timestamp, path }` for both `HttpException`
  and unhandled errors.
- `src/common/enums.ts` — `TicketStatus`, `TicketPriority`, `TicketType`,
  `UserRole` exactly as specified in CLAUDE.md.
- Empty `*.module.ts` for `auth`, `users`, `projects`, `tickets`, `comments`,
  `attachments`, `audit`, `scheduler`. Decorated with `@Module({})` — no
  controllers/providers yet.

### Key decisions
- `synchronize: true` is **dev-only**; flagged with a comment in
  `app.module.ts`. We'll keep it on for this assignment (no migrations
  framework needed for a 36-hour take-home) but document the caveat in
  `run.md` when we write it.
- `ConfigModule` is global so feature modules don't have to re-import it.
- Exception filter uses `Logger` to print stack traces for non-HTTP errors,
  but never leaks them in the response body.

### Verification
- `docker compose up -d` → Postgres healthy (`pg_isready` returns ready).
- `npm run start:dev` → app boots cleanly, all 10 modules initialize,
  `TypeOrmCoreModule dependencies initialized` confirms the DB handshake,
  `Nest application successfully started` on port 3000.

> Heads-up for future me: `nest start` internally `sh -c`s the node launch,
> so an `&` anywhere in the absolute path breaks `npm run start:dev`
> (shell treats `&` as a job separator). Keep clone paths free of `&`.

### Files touched
```
.env                                 (new, gitignored)
.env.example                         (new)
docs/session-log.md                  (new — this file)
package.json                         (deps added)
package-lock.json                    (auto)
src/app.module.ts                    (full rewrite)
src/main.ts                          (full rewrite)
src/common/all-exceptions.filter.ts  (new)
src/common/enums.ts                  (new)
src/auth/auth.module.ts              (new, empty)
src/users/users.module.ts            (new, empty)
src/projects/projects.module.ts      (new, empty)
src/tickets/tickets.module.ts        (new, empty)
src/comments/comments.module.ts      (new, empty)
src/attachments/attachments.module.ts (new, empty)
src/audit/audit.module.ts            (new, empty)
src/scheduler/scheduler.module.ts    (new, empty)
```

### Next session
- Define entities: `User`, `Project`, `Ticket`, `Comment`, `Attachment`,
  `AuditLog`, plus the ticket-dependency and comment-mention join tables.
- Wire `@DeleteDateColumn` (soft delete) on `Project`, `Ticket`, `Comment`.
- Wire `@VersionColumn` on `Ticket` and `Comment`.
- Stand up `AuditService.record(...)` since many modules will depend on it.
- Write the `TicketStatusMachine` unit tests **before** writing any
  controller (TDD per CLAUDE.md).

---

## Session 1 — Entities + Ticket state machine (TDD) (2026-05-28)

**Goal:** lock in the persistence layer and the core lifecycle rule as
pure, tested logic. No controllers, no HTTP, no auth.

### Entities
All 8 entities created in their respective module folders, registered via
`TypeOrmModule.forFeature` so `autoLoadEntities: true` picks them up.
Foreign keys live as plain columns — no `@ManyToOne`/`@OneToMany` yet, since
nothing queries them through relations. We'll add relation decorators only
where they justify their weight (likely for `Ticket→Comment` traversal).

- `src/users/user.entity.ts` — id, username (unique idx), email (unique idx),
  passwordHash, fullName, role enum, createdAt.
- `src/projects/project.entity.ts` — id, name, description, ownerId,
  created/updated/deletedAt (soft delete).
- `src/tickets/ticket.entity.ts` — id, title, description, status enum (default
  TODO), priority enum (default MEDIUM), type enum, projectId, assigneeId
  nullable, dueDate nullable, isOverdue (default false), `@VersionColumn`,
  created/updated/deletedAt. Two composite indexes:
  `(projectId, status)` for project ticket lists and `(assigneeId, status)`
  for workload queries.
- `src/tickets/ticket-dependency.entity.ts` — composite PK (`ticketId`,
  `blockedById`), plus index on `blockedById` so the reverse lookup is
  cheap when we need to know what a ticket blocks.
- `src/comments/comment.entity.ts` — id, ticketId, authorId, content,
  `@VersionColumn`, created/updatedAt. **No soft delete** on Comment —
  the README's "Soft Delete APIs" section explicitly limits soft delete to
  Tickets and Projects, and CLAUDE.md doesn't list Comment under it. So
  `DELETE /tickets/:id/comments/:cid` will be a hard delete.
- `src/comments/mention.entity.ts` — id, commentId, mentionedUserId, createdAt.
  Unique on `(commentId, mentionedUserId)` so the diff-update logic in §3.6
  cannot create duplicates if the same `@name` appears multiple times in a
  comment body.
- `src/attachments/attachment.entity.ts` — id, ticketId, filename, mimeType,
  sizeBytes (bigint — TypeORM maps to `string` in JS to avoid 2^53 precision
  loss; we'll parse to number for the 10 MB check), storagePath, uploadedById,
  createdAt.
- `src/audit/audit-log.entity.ts` — id, actorType enum (USER|SYSTEM),
  actorId nullable, action (varchar), entityType (varchar), entityId,
  beforeJson + afterJson as `jsonb`, createdAt. Indexes on
  `(entityType, entityId)`, `(action)`, and `(actorType, actorId)` to make
  the `GET /audit-logs` query filters fast.

`ActorType` enum (USER, SYSTEM) added to `src/common/enums.ts`.

### Table verification
After `npm run start:dev`, `docker compose exec db psql -U issueflow -d
issueflow -c '\dt'` showed all 8 tables: `attachments`, `audit_logs`,
`comments`, `mentions`, `projects`, `ticket_dependencies`, `tickets`,
`users`. Spot-checked `\d tickets` — status/priority/type postgres enums,
`isOverdue boolean default false`, `version`, `deletedAt` nullable, both
composite indexes present.

### Ticket state machine (TDD)
- `src/tickets/ticket-state-machine.ts` — pure function, no DB, no DI:
  ```ts
  assertTransitionAllowed(
    current: TicketStatus,
    target: TicketStatus,
    opts: { blockersAllDone: boolean },
  ): void
  ```
  Throws `InvalidTicketTransitionError` (a named subclass of `Error`) so the
  controller layer can map it cleanly to 400 — the rejection message names
  the broken rule, which we'll surface directly in the HTTP response.

- TDD flow: wrote `ticket-state-machine.spec.ts` first (24 cases), ran it,
  saw `TS2307: Cannot find module './ticket-state-machine'` (RED).
  Implemented, hit 23/24, fixed an ordering bug (see below), got 24/24
  green. Full suite: 25/25.

### Design decisions worth flagging
- **Reject skip-transitions.** `TODO → IN_REVIEW` / `TODO → DONE` /
  `IN_PROGRESS → DONE` all rejected. CLAUDE.md says "Allowed forward path
  ONLY: TODO → IN_PROGRESS → IN_REVIEW → DONE" — the stages exist precisely
  so review happens before done; allowing a skip would render `IN_REVIEW`
  meaningless. Rejection message says "skip lifecycle stages (sequential
  only)".
- **Reject same-status transitions.** `TODO → TODO` etc. rejected as no-ops.
  A real status change is always meaningful work, so silently accepting a
  no-op would mask bugs in callers (e.g. a UI that resends the same status
  by accident). Cheap defensive check.
- **Same-status beats DONE-terminal for `DONE → DONE`.** When current and
  target both equal DONE, both rules technically apply. The implementation
  checks same-status first because it's the more specific description of
  what the caller asked for ("no change") versus what they didn't do
  ("leave DONE"). This came out of a failing test on the first
  implementation pass — fixing the ordering, not the rule, made it green.
- **Blocker gate only fires on transitions INTO DONE.** Specifically the
  blockers check sits *after* the legal-transition check, so a transition
  like `TODO → IN_PROGRESS` with `blockersAllDone: false` succeeds (we don't
  care about blockers for non-DONE targets). A unit test pins this down.

### Files touched
```
src/common/enums.ts                          (added ActorType)
src/users/user.entity.ts                     (new)
src/users/users.module.ts                    (forFeature([User]))
src/projects/project.entity.ts               (new)
src/projects/projects.module.ts              (forFeature([Project]))
src/tickets/ticket.entity.ts                 (new)
src/tickets/ticket-dependency.entity.ts      (new)
src/tickets/tickets.module.ts                (forFeature([Ticket, TicketDependency]))
src/tickets/ticket-state-machine.ts          (new)
src/tickets/ticket-state-machine.spec.ts     (new, 24 cases)
src/comments/comment.entity.ts               (new)
src/comments/mention.entity.ts               (new)
src/comments/comments.module.ts              (forFeature([Comment, Mention]))
src/attachments/attachment.entity.ts         (new)
src/attachments/attachments.module.ts        (forFeature([Attachment]))
src/audit/audit-log.entity.ts                (new)
src/audit/audit.module.ts                    (forFeature([AuditLog]))
```

### Next session
- Wire `AuthModule` first (JWT login/logout/me, `JwtStrategy`, `JwtAuthGuard`,
  `RolesGuard`, token deny-list). Everything downstream needs `@CurrentUser`.
- Then `UsersService` + controller — small, mostly CRUD, useful smoke test
  for the validation pipe and exception filter.
- Stand up `AuditService.record(...)` alongside Users so it's available when
  Projects/Tickets land in the session after.
