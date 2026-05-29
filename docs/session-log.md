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

---

## Session 4 — Tickets core: CRUD + state machine wiring + If-Match locking + soft-delete (2026-05-28)

**Goal:** lock in the editable lifecycle of a Ticket. No dependencies / CSV /
auto-assign / escalation yet — those are later sessions. Stayed scoped.

### Endpoints (all 200, matching README)
- `POST /tickets` — validates `projectId` exists (404 if not), `assigneeId`
  exists if given (404 if not), all enums (400 if not). Defaults `status` to
  TODO; rejects `status: DONE` on create with a 400 ("ticket cannot be
  created directly in DONE"). Response includes `version` and an
  `ETag: "<version>"` header.
- `GET /tickets?projectId=:projectId` — query param (per README), validates
  project exists.
- `GET /tickets/deleted?projectId=:projectId` — **ADMIN-only**. Declared
  before `:ticketId` so "deleted" isn't matched as an integer id.
- `GET /tickets/:ticketId` — sets `ETag` header.
- `PATCH /tickets/:ticketId` — the complex one (see below).
- `DELETE /tickets/:ticketId` — soft delete via `softRemove`.
- `POST /tickets/:ticketId/restore` — **ADMIN-only**. 404 if not actually
  soft-deleted.

### How the state machine is wired into PATCH
The pure-function `assertTransitionAllowed` from Session 1 is called from
`TicketsService.update` only when `dto.status` is supplied AND differs from
the current status. On `InvalidTicketTransitionError` we catch and rethrow as
`BadRequestException(message)` — the rule-naming message becomes the 400 body.
`blockersAllDone: true` is hard-coded for now; there's a `TODO(session-5)`
right next to it to swap in the real blocker computation once dependencies
exist.

### Why DONE-frozen is a separate check (and runs first)
The state machine alone would already reject `DONE → anything` as a backward
or same-status transition. **But CLAUDE.md says DONE freezes *every field*,
not just status.** A `PATCH /tickets/:id { title: "..." }` on a DONE ticket
must also be rejected — even though no status transition is happening, and
even though the state machine would happily pass a no-status update through.

So `if (ticket.status === DONE) throw 409` lives in `update()` itself, ahead
of the state-machine call. It also runs **before** the If-Match check. A
frozen resource should report its frozen-ness, not lie about a missing or
stale version header — `PATCH /tickets/:done-id` with no `If-Match` returns
**409**, not 428. Pinned by an e2e case ("DONE-frozen wins over missing
If-Match").

### The full If-Match / ETag contract (for run.md)
- Every ticket response carries `version` in the body AND sets an
  `ETag: "<version>"` header. POST, GET, PATCH responses all do this so the
  client always has a fresh value to send back.
- `PATCH /tickets/:id` **requires** an `If-Match` header carrying the
  version the client based its edit on (e.g. `If-Match: "3"`). The parse is
  tolerant: `"3"`, `3`, and `W/"3"` are all accepted.
- **Missing** `If-Match` → **428 Precondition Required** with a message
  reminding the caller to carry the version. We refuse to silently accept
  unversioned writes — that would defeat the lock.
- **Stale** `If-Match` (the supplied version doesn't match the row's
  current version) → **412 Precondition Failed** with a message naming
  current and supplied versions.
- **On success**, the response body includes the new (incremented)
  `version` and the `ETag` header points to it.
- The DONE-frozen 409 fires **before** all of the above for terminal tickets.

### Defense-in-depth on the version (and one TypeORM gotcha worth a paragraph)
The user spec asked for two layers — explicit check + TypeORM
`@VersionColumn` catching `OptimisticLockVersionMismatchError` on save. The
first layer works as designed. **But:** TypeORM 0.3.x's
`repository.save(entity)` with `@VersionColumn` auto-increments the version
column in the UPDATE's SET clause but does **not** include the original
version in the WHERE clause — so it would silently overwrite a concurrent
writer, never throwing `OptimisticLockVersionMismatchError`. A direct unit
test in the first pass of this session confirmed that: side-channel-bump
the row from version 1 to 2, then `repo.save(stale)` and watch it resolve
quietly.

So the second line of defense is implemented as an **atomic conditional
UPDATE**:
```sql
UPDATE tickets SET ..., version = version + 1, updatedAt = now()
WHERE id = $1 AND version = $expected
```
If `result.affected === 0`, the explicit check passed for *both* concurrent
requests but Postgres's row-level lock serialized them — one's UPDATE found
version=N, the other found N+1 and matched zero rows. We map that to 412 with
the message *"Ticket was modified concurrently (race detected at write);
reload and retry"*. The atomic UPDATE replaces `save()` for the version-bump
path; we still use `save()` for `create()` where there's no version concern.

### How we proved the race-defense works
Two e2e cases:
1. **Concurrent HTTP race** (`Promise.allSettled` of two PATCH requests, both
   with `If-Match: "1"`). Asserts exactly one 200 and exactly one 412. Under
   Node's event loop the two findOnes typically run before either UPDATE, so
   both pass the explicit check; the atomic UPDATE then catches the loser at
   the DB.
2. **Deterministic side-channel** — load via repo, bump via the public PATCH,
   then run the same atomic conditional UPDATE the service uses with the
   stale version. Asserts `result.affected === 0` and the row's title is
   unchanged. No flake risk, exercises only the second-line-of-defense path.

### Tests
- Unit: 33/33 (unchanged — state machine still has its 24 pure cases).
- e2e: 42/42 total (25 new tickets cases + 17 prior). The 25 new ones cover:
  - **Create:** defaults TODO/v=1/ETag, reject status=DONE, 404 on bad
    projectId, 404 on bad assigneeId.
  - **State machine via PATCH:** skip rejected, backward rejected, full
    forward lifecycle with version bumps, DONE-frozen 409, DONE-frozen wins
    over missing If-Match.
  - **If-Match contract:** 428 missing, 412 stale, 200 correct + version
    increments + ETag, tolerant parse (quoted/unquoted), concurrent race
    412, deterministic atomic-UPDATE-rejects-stale.
  - **Validation:** unknown body fields (forbidNonWhitelisted), bad
    If-Match format (400).
  - **Soft-delete + admin:** DELETE soft-deletes, GET list/by-id hide it,
    ADMIN sees in /tickets/deleted, DEVELOPER → 403, ADMIN restores → back
    in list, DEVELOPER restore → 403, restore-not-deleted → 404.

### Files touched
```
src/tickets/dto/create-ticket.dto.ts     (new — reject status=DONE on create)
src/tickets/dto/update-ticket.dto.ts     (new — README fields only)
src/tickets/dto/list-tickets.dto.ts      (new — query ?projectId)
src/tickets/tickets.service.ts           (new — CRUD + SM + atomic UPDATE)
src/tickets/tickets.controller.ts        (new — routes + If-Match + ETag)
src/tickets/tickets.module.ts            (wire deps: Projects, Users, Auth)
test/tickets.e2e-spec.ts                 (new — 25 cases)
```

### Pending for run.md (when we write it)
- The full If-Match / ETag / 428 / 412 contract above belongs in run.md so
  reviewers know how to drive PATCH from curl/Postman without reading the
  service source.
- The session-0 password decision (`POST /users` accepts `password`) also
  belongs there.

### Next session
- `AuditService.record(...)` — inject into Projects and Tickets state-changing
  paths. Audit entries persisted; `GET /audit-logs` endpoint with the four
  query filters.
- `GET /projects/:id/workload`.
- Ticket **dependencies**: `POST /tickets/:id/dependencies`,
  `GET /tickets/:id/dependencies`,
  `DELETE /tickets/:id/dependencies/:blockerId`. Then replace the hard-coded
  `blockersAllDone: true` with real computation.
- Comments + mentions, with the mention-diff logic.
- Auto-assignment on ticket create; escalation scheduler.
- CSV import/export.

---

## Session 5 — Dependencies, real DONE-blocker rule, auto-assignment, workload, minimal AuditService (2026-05-29)

**Goal:** wire the rest of the ticket lifecycle pieces that depend on data
already in place. No CSV / escalation / attachments / mentions / audit
endpoint yet — kept scope tight.

### Endpoints added
- `POST /tickets/:ticketId/dependencies` — body `{ blockedBy }`, 200 OK.
- `GET /tickets/:ticketId/dependencies` — list of blocker tickets (soft-deleted
  blockers are silently filtered out).
- `DELETE /tickets/:ticketId/dependencies/:blockerId` — 200; 404 if the row
  doesn't exist.
- `GET /projects/:projectId/workload` — `[ { userId, username, openTicketCount } ]`
  sorted ascending by count, then by registration order.

### Cycle detection
`TicketDependenciesService.wouldCreateCycle(targetTicketId, newBlockerId)`
runs BFS from `newBlockerId` along existing `blockedBy` edges. If
`targetTicketId` is reachable, the new edge would close a cycle
`target → newBlocker → … → target` — reject 400. The traversal uses a
`visited` set so any pre-existing cycle (shouldn't happen, but defensive)
doesn't loop forever. Per-step DB queries; the dependency graph is
tiny in practice. Three test cases lock this down: self-dep (immediate
reject), 2-node `A↔B`, 3-node `A→B→C→A` (proves BFS handles depth).

Cross-project rejection happens *before* the cycle check; we don't bother
traversing a graph whose end-points couldn't validly be connected anyway.

### Real DONE-blocker rule (replacing Session 4's `blockersAllDone: true`)
In `TicketsService.update`, when the target status is DONE, we compute
`openBlockerIds` from `TicketDependenciesService.openBlockerIds(ticketId)`
(blockers whose status is not DONE; soft-deleted blockers are filtered out
by the default scope). The boolean `blockersAllDone = openBlockerIds.length === 0`
goes to the state machine — so the pure function still encodes the rule and
is the source of truth. The state machine's rejection is caught, and when
the cause was blockers we throw a richer 400:

```
Cannot transition to DONE: blocked by tickets [42, 57]
```

The state machine's own generic message is preserved for any *other* kind
of rejection that bubbles through that catch.

### Auto-assignment
On `POST /tickets`, if `dto.assigneeId` is undefined, we call
`WorkloadService.pickAutoAssignee(projectId)` — same query as the public
workload endpoint, returning the first entry's `userId` (or `null` if no
DEVELOPERs exist). When assigneeId comes from the request, we honor it
(after validating the user exists). Auto-assign **never** runs on update;
that path already accepts `assigneeId` from the client unchanged.

**Tie-breaker logic** (CLAUDE.md §3.8): the workload SQL orders by
`COUNT(t.id) ASC, u.createdAt ASC, u.id ASC`. So among devs with the
lowest open count, the earliest registered wins; if `createdAt` is
identical (which it won't be in practice — Postgres timestamps are
microsecond-granular), `id ASC` breaks the final tie deterministically.

### Why WorkloadService lives in `projects/` (not `tickets/`)
The endpoint URL is `/projects/:id/workload`, so the route belongs in
`ProjectsController`. But the query needs Ticket + User repos. Putting
the service in `TicketsModule` would force a Tickets ↔ Projects circular
import (TicketsModule already imports ProjectsModule for project lookups).
Putting it in `ProjectsModule` and registering Ticket + User entities for
its `forFeature` keeps the dependency direction clean: ProjectsModule has
no service-level dependency on TicketsModule, just direct entity access.
ProjectsModule exports `WorkloadService` so `TicketsService.create` can
inject it for auto-assign.

### Assumption documented in code (`workload.service.ts`)
The README has no project-membership concept (projects have an `ownerId`,
nothing else). So "the DEVELOPERs in the project" effectively means "all
DEVELOPERs in the system" — a developer with zero tickets in this project
is the strongest auto-assign candidate and is included in the workload
response with `openTicketCount: 0`.

### Minimal AuditService scope
Only `AUTO_ASSIGN` (with `actorType: SYSTEM`) is recorded this session;
all the other state-changing paths will be retrofitted in Session 6 when
the `GET /audit-logs` endpoint also lands. Keeping this session tight on
purpose. The audit row is asserted directly from the DB in an e2e case to
verify the shape (`actorType: 'SYSTEM'`, `actorId: null`, `action:
'AUTO_ASSIGN'`, `entityType: 'Ticket'`, `entityId`, `afterJson:
{ assigneeId }`).

If `pickAutoAssignee` returns `null` (no DEVELOPERs at all), the ticket
saves with `assigneeId: null` and **no audit row is written** — the audit
is for "I assigned X to Y", not "I tried and failed". Pinned by an e2e
case.

### Test infrastructure fix: serial e2e
Adding the dependencies suite revealed Jest's default parallel-worker
strategy was interleaving e2e suites that share the same Postgres DB —
TRUNCATEs in one beforeAll were wiping the other's setup mid-run. Two
test files passed in isolation, both failed when run together. Fixed by
adding `"maxWorkers": 1` to `test/jest-e2e.json`. The e2e config is
inherently serial because of the shared DB; setting this explicitly
removes the latent flake. With this in place: 5 suites, 68 cases, all
green when run together.

### Tests
- Unit: 33/33 (unchanged).
- e2e: 68/68 across 5 suites (26 new in `dependencies-and-autoassign.e2e-spec.ts`):
  - Auto-assign: ADMIN never chosen; [0,0] tie → A; [1,0] → B; [1,1] tie → A
    again; explicit honored; bad explicit → 404; audit row shape verified;
    no DEVELOPERs → null + no audit.
  - Workload: ascending counts; includes zeros; excludes ADMINs; DONE
    doesn't count; works for DEVELOPER token; 401 no token; 404 unknown
    project.
  - Dependencies: add + list; self → 400; cross-project → 400; 2-node
    cycle → 400; 3-node cycle → 400; delete + 404-on-second-delete;
    soft-deleted blocker hidden from list; soft-deleted ticket cannot be
    added as a blocker → 404; idempotent re-add.
  - DONE-blocker rule: 400 names blocker id; resolve blocker → DONE
    succeeds; no blockers → freely DONE; multiple open → message lists
    all ids.

### Files touched
```
src/audit/audit.service.ts                       (new — record() only)
src/audit/audit.module.ts                        (exports AuditService)
src/projects/workload.service.ts                 (new — query + autoassign pick)
src/projects/projects.module.ts                  (registers Ticket+User entities; exports WorkloadService)
src/projects/projects.controller.ts              (GET :projectId/workload)
src/tickets/ticket-dependencies.service.ts       (new — CRUD + cycle BFS + openBlockerIds)
src/tickets/ticket-dependencies.controller.ts    (new — POST/GET/DELETE)
src/tickets/tickets.service.ts                   (real blocker check on update; auto-assign on create; audit AUTO_ASSIGN)
src/tickets/tickets.module.ts                    (imports AuditModule; registers deps controller/service)
test/dependencies-and-autoassign.e2e-spec.ts     (new — 26 cases)
test/jest-e2e.json                               (maxWorkers: 1 to stop suite interleaving)
```

### Next session
- Retrofit `AuditService.record(...)` into every state-changing path
  (Project create/update/delete, Ticket create/update/delete, User
  create/update/delete, dependency add/remove). Each call carries the
  before/after JSON.
- `GET /audit-logs` with the four query filters (`entityType`, `entityId`,
  `action`, `actor`).
- Comments + mentions (mention diff on update).
- Attachments (10 MB cap, MIME allow-list).
- CSV import/export.
- Escalation scheduler.

---

## Session 6 — Audit retrofit across all state-changing ops + GET /audit-logs (2026-05-29)

**Goal:** every state-changing operation lands a row in `audit_logs` with a
full before/after snapshot and the actor identity. New `GET /audit-logs`
endpoint (ADMIN-only) lets reviewers query it.

### Action and entity-type constants
All audit strings live in one file (`src/audit/audit-actions.ts`) as the
`AuditActions` object literal:
- USER_CREATE, USER_UPDATE, USER_DELETE
- PROJECT_CREATE, PROJECT_UPDATE, PROJECT_DELETE, PROJECT_RESTORE
- TICKET_CREATE, TICKET_UPDATE, TICKET_DELETE, TICKET_RESTORE
- DEPENDENCY_ADD, DEPENDENCY_REMOVE
- AUTO_ASSIGN  (already from Session 5)

Entity types are `'User' | 'Project' | 'Ticket'` constants in
`AuditEntityTypes`. No free-text strings anywhere in service code.

### Snapshot strategy

**Full snapshot, not diff.** Each before/after carries the entire entity at
that moment in time. Diff-only snapshots would force readers to reconstruct
prior state by walking back through every prior audit row in chronological
order — a real pain at 3 a.m. when something broke. With full snapshots, any
single row is self-contained: open it, see exactly what changed and what the
state was, no reconstruction required. Storage is cheap; debugging time is
expensive.

`before` is captured by cloning the loaded entity (shallow spread —
sufficient because none of our entities have nested objects worth deep
cloning) BEFORE the mutation. `after` is the entity post-save / post-restore.
For soft-delete, `after` is the entity with `deletedAt` set, so a reviewer
can see both the pre-delete state and the deletion timestamp in a single row.
For hard delete (Users only), `after` is `null` — the row is gone.

**Centralized passwordHash strip.** The `User` entity has `@Exclude()` on
`passwordHash`, and `class-transformer.instanceToPlain(entity)` honors that —
so converting an entity to a plain object already drops the hash. But the
service receives whatever the caller passes (could be an entity, could be a
plain object), and a future refactor could remove `@Exclude` without
realising the consequences for audit. So `AuditService.snapshot()`:
1. Calls `instanceToPlain()` (no-op for plain objects; respects `@Exclude` on
   entities).
2. If `entityType === 'User'`, explicitly `delete plain.passwordHash`.

Belt and suspenders. The test "USER_CREATE audit row has no passwordHash"
asserts this end-to-end.

### Failed operations never leave an audit row

The invariant: **`audit.record()` is the last `await` in every state-
changing method, after the DB write.** If any earlier step throws — 404
(not found), 409 (DONE-frozen, dup), 412 (stale or race), 400 (state-machine
or cycle), 401/403 (guards) — control never reaches the audit call. The
row in `audit_logs` only exists when the user's mutation actually
committed.

The catch is that `before` is captured at the top of the method (after the
load). That's a local variable, not a DB write — it's free to die with the
function. Four e2e cases lock this down (412 stale If-Match → 0 rows; 428
missing → 0 rows; 409 DONE-frozen → 0 rows; 404 bad assigneeId on create →
0 rows).

### Actor identification: how it flows controller → service

Service layer must stay HTTP-agnostic (it shouldn't know `req.user` exists).
So the controller does the JWT→actor translation and passes a domain object:

- `src/audit/actor.ts` defines `ActorContext = { actorType, actorId }`,
  plus `SYSTEM_ACTOR` (for scheduler-style callers) and `actorFrom(user)`
  (controllers' helper).
- Every state-changing service method has `actorContext` as its last
  parameter — **not optional**, so you can't forget to pass it. TypeScript
  catches the omission at compile time.
- Controllers all use `@CurrentUser() user: AuthUser` and call
  `actorFrom(user)` once per route.

**Special case: USER_CREATE via public registration.** `POST /users` is
`@Public`, so there's no JWT and `req.user` is undefined. We resolve this in
the service: `UsersService.create()` doesn't take `actorContext` at all —
it generates self-actor (`actorType: USER`, `actorId: saved.id`) right after
the save. Self-registration → the new user is the audit actor of their own
creation. Clean story; documented in code.

### Auto-assigned create yields TWO audit rows

By design — the user-driven create (TICKET_CREATE) and the system-driven
assignment (AUTO_ASSIGN) are two distinct events. They're logged separately
so an operator can answer "which tickets did the system auto-assign?" with
a single `?action=AUTO_ASSIGN` filter, separately from "which tickets did
user X create?" via `?actor=X&action=TICKET_CREATE`. Verified by the
e2e case "auto-assigned create → TWO rows: TICKET_CREATE + AUTO_ASSIGN";
manually-assigned create produces only the TICKET_CREATE row.

### GET /audit-logs

- ADMIN-only — `@UseGuards(JwtAuthGuard, RolesGuard) + @Roles(UserRole.ADMIN)`
  at the controller level (every route in this controller requires ADMIN).
- Query DTO (`QueryAuditLogsDto`) with class-validator:
  - `entityType`, `action`: optional strings (kept as plain strings for
    forward compat — new actions don't have to update an enum).
  - `entityId`, `actor`: optional positive integers; coerced from query
    strings via `@Type(() => Number)`.
  - `from`, `to`: optional ISO timestamps; coerced via `@Type(() => Date)`.
  - `page` (default 1), `limit` (default 50, `@Max(200)`).
  - All filters AND-combine.
- `actor` in the URL is interpreted as `actorId` (per CLAUDE.md / README);
  the DTO comment names this so reviewers don't have to guess.
- Sort: `createdAt DESC` (newest first).
- Response: `{ data, total, page, limit }`.

### One refactoring detail: avoiding a module cycle

Naive wiring would have been: `AuditModule` imports `AuthModule` (for
`RolesGuard`), `UsersModule` imports `AuditModule` (for the service),
`AuthModule` imports `UsersModule` (already does). That's a cycle.

Fixed by **providing `JwtAuthGuard` and `RolesGuard` directly in
`AuditModule`** instead of importing `AuthModule`. Neither guard has any
service-level dependency on `AuthService` — they only need `Reflector`
(globally available via `@nestjs/core`) and, in the case of `JwtAuthGuard`,
the 'jwt' passport strategy which is registered globally once `AuthModule`
itself initializes elsewhere in the app graph. Nest's DI is happy to have
the same guard class declared in multiple modules.

### Tests
- Unit: 33/33 (unchanged).
- e2e: **88/88 across 6 suites** — 20 new in `audit.e2e-spec.ts`:
  - **Retrofit:** exactly-one-row for manual-assign create, project
    update, ticket restore; two-row for auto-assigned create.
  - **passwordHash filter:** `USER_CREATE.afterJson.passwordHash` is
    undefined; other fields present.
  - **Failed-op-no-audit:** 412 stale, 428 missing, 409 DONE-frozen, 404
    bad assignee.
  - **GET /audit-logs:** no filter (all rows newest first); by
    entityType; by action; combined; by actor; pagination (page 2);
    limit > 200 → 400; bad entityId → 400; DEVELOPER → 403; no token → 401.

Two e2e cases from Session 5 needed updating to reflect that
auto-assigned creates now yield two rows. One of them was further
hardened with an `afterEach` that restores demoted devs even if the
test's assertion throws — otherwise downstream workload tests cascaded
into "undefined" errors. (Old setup put the restoration inline AFTER
the failing assertion.) Worth remembering: any test that mutates global
state should clean up in `afterEach`, not at the end of the test body.

### Files touched
```
src/audit/audit-actions.ts                   (new — string constants)
src/audit/actor.ts                           (new — ActorContext + helper)
src/audit/audit.service.ts                   (extended: query, snapshot+strip)
src/audit/dto/query-audit-logs.dto.ts        (new — validated filters)
src/audit/audit.controller.ts                (new — ADMIN-only GET)
src/audit/audit.module.ts                    (controller + provides guards locally)
src/users/user.entity.ts                     (no change — @Exclude already there)
src/users/users.module.ts                    (imports AuditModule)
src/users/users.service.ts                   (audit USER_CREATE/UPDATE/DELETE; self-actor for create)
src/users/users.controller.ts                (passes actor to update/delete)
src/projects/projects.module.ts              (imports AuditModule)
src/projects/projects.service.ts             (audit all 4 ops)
src/projects/projects.controller.ts          (passes actor to all writes)
src/tickets/tickets.service.ts               (audit TICKET_CREATE/UPDATE/DELETE/RESTORE; AUTO_ASSIGN preserved)
src/tickets/tickets.controller.ts            (passes actor)
src/tickets/ticket-dependencies.service.ts   (audit DEPENDENCY_ADD/REMOVE)
src/tickets/ticket-dependencies.controller.ts(passes actor)
test/audit.e2e-spec.ts                       (new — 20 cases)
test/dependencies-and-autoassign.e2e-spec.ts (2 cases updated to expect TICKET_CREATE row; afterEach for role cleanup)
```

### Next session
- Comments + mentions (mention-diff logic on update; `mentionedUsers`
  embedded in responses; `GET /users/:id/mentions` paginated).
- Attachments (10 MB cap; MIME allow-list).
- CSV export/import (use `csv-parse` and `csv-stringify`; comma+quote
  roundtrip is a reviewer-probe).
- Escalation scheduler.
- Finally, `run.md` (now overdue — should explain dev setup AND the
  If-Match / ETag / 428 / 412 contract, the audit query parameters,
  and the password-on-create decision).
