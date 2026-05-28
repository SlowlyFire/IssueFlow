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
