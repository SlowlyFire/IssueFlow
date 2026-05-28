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

---

## Session 2 — Auth + Users (2026-05-28)

**Goal:** end-to-end JWT auth plus full Users CRUD. Everything authenticated
by default; `@Public()` is the opt-out.

### Users module
- `UsersService` — bcrypt (rounds = 10) on `create`; `assertUnique` does a
  single OR-query against `(username | email)` and reports which one
  collided with a 409. `findByUsername` is **password-aware** (returns the
  full entity including `passwordHash`) and is the only path AuthService
  uses to verify credentials — every other read goes through `findOne`,
  which serializes through `ClassSerializerInterceptor` and strips
  `passwordHash` via the `@Exclude` decorator on the entity field.
- `UsersController` matches the README contract exactly: `POST /users`,
  `GET /users`, `GET /users/:userId`, `POST /users/update/:userId`,
  `DELETE /users/:userId`. Every non-GET route is annotated `@HttpCode(200)`
  per CLAUDE.md ("All success responses are 200 OK"). Update accepts only
  `fullName` and `role`, per the contract.
- DTOs use class-validator: `@IsEmail`, `@IsEnum(UserRole)`, username
  regex `[a-zA-Z0-9_.-]+` of length 3–64, password ≥ 8 chars. Anything else
  in the body is bounced by the global `forbidNonWhitelisted` —
  verified live with `{"isAdmin": true}` → 400.

### Auth module
- `POST /auth/login` — generic 401 ("Invalid credentials") on both wrong
  password AND missing user. We also run `bcrypt.compare` against a fake
  hash when the user is missing so response timing doesn't disclose
  whether the username exists. Pinned by an e2e test that asserts the two
  401 bodies are byte-identical.
- JWT payload: `{ sub: userId, username, role, jti }`. `jti` is a `randomUUID`
  generated at sign time — it's the key the deny-list keys on.
- `POST /auth/logout` — adds the request's `jti` to `TokenDenyListService`.
- `GET /auth/me` — reads `req.user` (populated by `JwtStrategy.validate`) via
  a `@CurrentUser()` param decorator and re-fetches the full profile from
  the DB. (We could return the JWT payload directly, but reading from the
  DB means a role change is reflected immediately on the user's next
  /auth/me without needing to invalidate the token.)

### Guard wiring (this is the most important design choice in this session)
- `JwtAuthGuard` is registered **globally** via `APP_GUARD` in `AppModule`.
  So **every** route is locked down by default. To open a route, slap
  `@Public()` on it. The two places this matters today are `POST /users`
  (registration) and `POST /auth/login`. The existing `GET /` health route
  also gets `@Public`.
- `JwtAuthGuard` first reads `IS_PUBLIC_KEY` via `Reflector.getAllAndOverride`
  (handler-then-class); if public, short-circuits to `true` and skips
  passport entirely. Otherwise it calls `super.canActivate` which runs
  passport-jwt, which calls `JwtStrategy.validate`, which **also** checks
  the deny-list. So a revoked token fails in `validate`, not in the guard
  itself — keeping the deny-list logic next to the rest of the auth-claim
  logic.
- `RolesGuard` is built and exported but **not** wired globally yet. Once
  the admin-only routes land (e.g. `GET /projects/deleted`) we'll add
  `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(UserRole.ADMIN)`
  per-route. Building it now means those endpoints become a one-line
  retrofit.

### Deny-list design
- `TokenDenyListService` is a simple `Set<string>` of `jti`s.
- In-memory, process-local — **resets on restart**. Documented inline in
  the service file. Acceptable for this assignment because:
  1. There's a single process behind the API.
  2. After a restart, the only tokens that survive are ones whose owners
     never logged out (i.e. equivalent to never having logged out yet).
  3. Tokens expire on their own after `JWT_EXPIRES_IN` (3600s by default),
     so the deny-list never has to remember anything past one hour.
- A production deployment would back this with Redis keyed by `jti` with
  `EXPIRE` set to the token's `exp - now`, so each entry frees itself.

### passwordHash never leaks
- `@Exclude()` on `User.passwordHash` + `ClassSerializerInterceptor`
  globally via `APP_INTERCEPTOR`. The e2e test asserts
  `expect(body).not.toHaveProperty('passwordHash')` on both the registration
  response and `/auth/me`.

### Tests
- Unit: 33/33 (incl. 4 deny-list cases, 4 bcrypt cases, the existing 24
  state-machine cases, and the Nest scaffold spec).
- e2e: 5/5 across `app.e2e-spec.ts` and a new `auth.e2e-spec.ts`. The auth
  e2e truncates the `users` table in `beforeAll` so the run is
  deterministic even when re-run on the same dev DB.
- Manual smoke (curl): register → login → /auth/me (200, no passwordHash) →
  no-token (401) → logout (200) → reused-token (401 "revoked") →
  duplicate-registration (409). All confirmed against a live dev server.

### Files touched
```
src/app.module.ts                                   (global guard + interceptor)
src/app.controller.ts                               (@Public on /)
src/users/user.entity.ts                            (@Exclude on passwordHash)
src/users/dto/create-user.dto.ts                    (new)
src/users/dto/update-user.dto.ts                    (new)
src/users/users.service.ts                          (new — bcrypt, unique, CRUD)
src/users/users.controller.ts                       (new — README endpoints)
src/users/users.module.ts                           (controller + service)
src/auth/dto/login.dto.ts                           (new)
src/auth/auth.service.ts                            (new — login + logout)
src/auth/auth.controller.ts                         (new — login/logout/me)
src/auth/auth.module.ts                             (JwtModule wiring)
src/auth/jwt.strategy.ts                            (new — checks deny-list)
src/auth/jwt-auth.guard.ts                          (new — respects @Public)
src/auth/roles.guard.ts                             (new — not yet applied)
src/auth/token-deny-list.service.ts                 (new — in-memory)
src/auth/token-deny-list.service.spec.ts            (new, 4 cases)
src/auth/password.spec.ts                           (new, 4 cases)
src/common/decorators/public.decorator.ts           (new)
src/common/decorators/roles.decorator.ts            (new)
src/common/decorators/current-user.decorator.ts     (new)
test/app.e2e-spec.ts                                (mirrors main.ts globals)
test/auth.e2e-spec.ts                               (new, 4 cases)
```

### Next session
- `AuditService.record(...)` — needs to exist before Projects/Tickets so
  the state-changing endpoints can audit cleanly. Tiny module: one method,
  one repo, no controller yet (we'll add `GET /audit-logs` in the same
  session as Projects).
- Projects CRUD + soft-delete + `GET /projects/:id/workload`. Soft delete is
  the first place we need `@Roles(UserRole.ADMIN)` — wire RolesGuard then.
- Once Projects exists, start Tickets: the state machine moves from
  pure-function to plumbed-into-the-service, plus dependencies and CSV
  export/import.

---

## Session 3 — Projects CRUD + soft-delete + admin endpoints (2026-05-28)

**Goal:** full Projects CRUD with the soft-delete pattern established cleanly
so the Tickets session can mirror it. First live use of RolesGuard.

### How TypeORM hides soft-deleted rows automatically

TypeORM tracks a `@DeleteDateColumn` field (`deletedAt`). When any query runs
through a Repository (`.find`, `.findOne`, `createQueryBuilder`) TypeORM
automatically appends `WHERE "deletedAt" IS NULL` — no manual filtering needed.
The two places where we intentionally bypass this behaviour:
- `listDeleted()` — `find({ withDeleted: true, where: { deletedAt: Not(IsNull()) } })`:
  `withDeleted: true` lifts the automatic filter; then `Not(IsNull())` keeps only
  the actually-deleted rows (without the filter, active rows would also show).
- `restore()` — first a `findOne({ withDeleted: true, where: { id, deletedAt: Not(IsNull()) } })`
  to confirm the project exists AND is soft-deleted (returns 404 otherwise, not a
  silent no-op), then `repository.restore(id)` which sets `deletedAt = NULL`.

`softRemove(entity)` was used for the delete path (rather than `softDelete(id)`)
because `softRemove` triggers TypeORM lifecycle hooks and cascades — consistent
with how we'll do ticket soft-delete.

### Soft-delete pattern comment
A single block comment at the top of `projects.service.ts` describes the
three-operation pattern (standard read / list-deleted / restore) so the
tickets service session can mirror it without re-deriving.

### How RolesGuard enforces ADMIN

`RolesGuard` is applied **per-route** with `@UseGuards(JwtAuthGuard, RolesGuard)`.
It reads `@Roles(UserRole.ADMIN)` via `Reflector.getAllAndOverride`. If the
current user's `role` (from the JWT payload, set by `JwtStrategy.validate`)
is not in the required list, it throws `ForbiddenException` ("Requires role(s):
ADMIN") → 403.

Why per-route rather than global? The vast majority of endpoints don't need a
role restriction — they just need to be authenticated. Adding `RolesGuard`
globally would be no-op on every unannotated route, but it would also fire on
every request, adding one more reflection lookup to the hot path for no benefit.
Per-route is also more legible: the decorator sits right next to the handler,
making the access policy visible at a glance.

`RolesGuard` is now exported from `AuthModule` so any feature module that
imports `AuthModule` can use it in `@UseGuards` without registering it again.

### Route order matters for `/projects/deleted`

`/projects/deleted` is declared **before** `/:projectId` in the controller.
Nest/Express register routes in declaration order — if `/:projectId` came first,
the string "deleted" would be matched as an integer param, `ParseIntPipe` would
throw 400 on `NaN`, and the admin endpoint would never be reachable. The same
ordering rule applies to `/tickets/export`, `/tickets/deleted` etc. in the next
session.

### ownerId validation

`POST /projects` calls `UsersService.findOne(dto.ownerId)` before saving. If the
user doesn't exist it throws `NotFoundException` → 404. This is the only FK we
validate in the service layer (the DB has no FK constraints since we're using
plain columns). Validated by an e2e test case.

### Tests
- e2e: 17/17 total (12 new projects cases + 5 carried over).
- Unit: 33/33 (unchanged).
- The 12 projects cases cover the full lifecycle in order:
  create, bad ownerId (404), soft-delete, gone-from-list, 404-by-id,
  visible-in-/deleted (ADMIN), 403-on-/deleted (DEVELOPER), restore,
  back-in-list, 403-on-restore (DEVELOPER), 401-on-restore (no token),
  PATCH update.

### Files touched
```
src/auth/auth.module.ts                  (export RolesGuard)
src/projects/dto/create-project.dto.ts   (new)
src/projects/dto/update-project.dto.ts   (new)
src/projects/projects.service.ts         (new — CRUD + soft-delete + admin)
src/projects/projects.controller.ts      (new — all README routes + admin)
src/projects/projects.module.ts          (controller + service + AuthModule import)
test/projects.e2e-spec.ts               (new — 12 cases)
```

### Next session
- `AuditService.record(...)` — inject into Projects and Tickets. Small module,
  one method, no HTTP controller yet; `GET /audit-logs` endpoint can land in
  the same session or a dedicated pass.
- `GET /projects/:id/workload` — joins User + Ticket, counts non-DONE tickets
  per developer in the project; depends on Ticket entity existing (it does).
- Tickets CRUD + state machine plumbed into service + dependencies +
  soft-delete (mirrors the projects pattern) + CSV export/import.
- Comments + Mentions; auto-assignment on ticket create; escalation scheduler.
