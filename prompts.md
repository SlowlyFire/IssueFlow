# Working with Claude Code on IssueFlow

This document describes how I used AI assistance to build IssueFlow — a NestJS/TypeScript/PostgreSQL ticket-tracking backend — for the AT&T TDP 2026 take-home assignment. The system implements user auth, project and ticket lifecycle (including a state machine, optimistic locking, soft-delete, and dependencies), @mention parsing with comment-level diffing, file attachments with magic-number validation, a priority-escalation cron scheduler, CSV bulk import/export, and a full audit log of every state-changing operation.

I used Claude Code as the implementation agent throughout. My role was to scope each session, write or verify the test cases that defined correctness, review every design decision before it was committed, and push back when the agent's first pass was wrong. The spec requires that I be fully accountable for the code in an interview, so I treated the agent the way a senior engineer treats a competent but junior colleague: give a clear brief, watch the work, question assumptions, and never accept "it looks right" as a substitute for "a test proves it."

---

## 1. Model & tools

**Claude Opus 4.7**: used in Claude Code for the highest-stakes implementation sessions — the state machine and TDD discipline (Session 1), tickets core with explicit optimistic locking (Session 4), and dependencies + auto-assignment with cycle detection (Session 5). Also used in Claude.ai chat for architecture planning and prompt engineering throughout.

**Claude Sonnet 4.6**: used in Claude Code for the more routine sessions — audit retrofit (Session 6), attachments (Session 8), escalation scheduler (Session 9), CSV (Session 10), and the documentation passes. Faster and cheaper per token, and once the design was settled the marginal benefit of Opus dropped sharply.

The model for each session was chosen by task type, not subscription convenience. Switching mid-session was avoided because Claude Code's prompt cache is per-model — re-reading the conversation cache after a switch costs more than the speed difference saves on short sessions.

---

## 2. Working method

### Session-based structure

I broke the work into ten focused sessions: bootstrap, entities + state machine, auth + users, projects, tickets core, dependencies + auto-assign, audit retrofit, comments + mentions, attachments, escalation scheduler, and CSV. Each session had a single declared goal written at the top of the prompt. The agent was told explicitly what was out of scope for that session, because without that constraint it would tend to reach forward and wire things that weren't yet needed, making the commit diff much harder to review. Session boundaries also meant each session started with a fresh model context load of `CLAUDE.md` and `docs/session-log.md`, so no implicit state accumulated across days.

### CLAUDE.md as project memory

`CLAUDE.md` encodes the non-negotiable rules: the stack (NestJS 10 only, TypeORM 0.3.x, no Nest 11 regardless of what the PDF says), the README as the implementation contract, the exact enum values, the business rules for the state machine, escalation, auto-assign, and CSV, and the workflow rules for the agent (explain before committing, never invent endpoints, always state assumptions). It was stable across all ten sessions — I only added to it when a new irreversible decision was made. Any rule in CLAUDE.md meant I did not have to re-litigate it every session.

### docs/session-log.md as handoff

At the end of each session the agent appended a structured log entry: what was built, key design decisions and their rationale, files touched, test counts, and what to do next. This served two purposes: it gave the next session enough context to continue without re-reading all the code, and it is the raw record from which this document is distilled. A reviewer who wants the detailed version of any decision covered here can read the relevant session entry directly.

### Accountability checkpoints

After each session produced code, I asked the agent to explain the key design decisions back to me in plain language before I confirmed the commit. This is not optional courtesy — the spec states I am fully accountable for the code. If I could not follow the explanation or if it revealed an assumption I hadn't authorized, I pushed back before the commit. Several of the corrections documented in section 4 came from this step.

### TDD for pure business logic

The state machine (Session 1), mention parser (Session 7), and escalation function (Session 9) were all written test-first. In each case I sent a prompt that listed the specific test cases — covering edge cases I cared about, not just the happy path — and told the agent to write the spec file first, run it (RED), implement the function, and show me the transition from red to green. The failing test run is in the session log for Session 1: 24 cases written, TS2307 import error (correct — the module didn't exist yet), 23/24 after first implementation (ordering bug in same-status vs DONE detection), 24/24 after the fix. I did not authorize the commit at 23/24.

### Model selection

I chose the model for each session by task type, not by convenience. Hard reasoning tasks (designing the optimistic-locking model, working out why the @VersionColumn was insufficient) went to Opus in chat first. Once I understood the design, I handed a clear brief to Sonnet in Claude Code. For sessions that were mostly scaffolding (projects CRUD, CSV controller plumbing), I went straight to Sonnet.

---

## 3. Curated prompts and what I changed

### State machine: tests before implementation

**Context:** Session 1. The ticket state machine is the most business-critical pure-logic component in the system — the spec's reviewer will probe it directly.

**Prompt (condensed):** Write the unit tests for `assertTransitionAllowed` first. Cover at minimum: every valid forward transition, every backward transition (all rejected), every skip (TODO→DONE, TODO→IN_REVIEW, etc.), same-status no-ops, the DONE-frozen rule for all updates, and the blocker gate — specifically that the blocker check only fires on transitions INTO DONE, not on other transitions where `blockersAllDone` is false. Run the tests. Show me the red output. Then implement the function.

**What the agent produced:** 24 test cases in `ticket-state-machine.spec.ts`, a TS2307 import error on the first run (module didn't exist), then an implementation that hit 23/24. The failing case was `DONE → DONE`: the implementation hit the DONE-terminal check before the same-status check, so the error message was wrong.

**What I changed:** I held the commit at 23/24 and asked for the root cause. The agent identified that checking `current === DONE` before `current === target` produced the wrong message for the `DONE → DONE` case. The fix was to reorder the checks: same-status first, then DONE-terminal. I verified the logic made semantic sense (a caller asking for `DONE → DONE` is doing a no-op, not trying to leave DONE) before approving.

---

### Explicit optimistic locking via atomic conditional UPDATE

**Context:** Session 4. PATCH /tickets/:id needs to prevent lost-update races. My first assumption was that TypeORM's @VersionColumn would throw `OptimisticLockVersionMismatchError` on a stale `save()`. I specifically asked the agent to test whether that assumption was true.

**Prompt (condensed):** Before writing the normal PATCH flow, write a concurrency test: load the ticket via the repo, separately bump its version via a direct SQL UPDATE (simulating a concurrent writer), then call `repo.save(staleEntity)` and assert it throws `OptimisticLockVersionMismatchError`. Run it. If it passes, proceed. If it fails, diagnose and fix before doing anything else.

**What the agent produced:** The test — and it failed. `repo.save()` on a stale entity completed silently, version incremented to the wrong value, no error thrown. The agent explained why: TypeORM 0.3.x auto-increments the version column in the SET clause of the UPDATE but does not include the original version in the WHERE clause, so it always overwrites regardless of concurrent writes.

**What I changed:** I told the agent to replace `save()` for the update path with an atomic conditional UPDATE — `UPDATE tickets SET … version = version + 1 WHERE id = $1 AND version = $expected` — mapping `result.affected === 0` to 412. The explicit If-Match header check became the first line of defense, the conditional UPDATE became the second. Both are in the final code. The original concurrency test was reworked to prove the second line of defense works: bump the version externally between the explicit check and the UPDATE, confirm `affected === 0`.

---

### Audit retrofit: failed operations must never leave a row

**Context:** Session 6. Retrofitting audit calls into every state-changing service method, with a specific invariant: if any step before the audit call throws — 404, 409, 412, 400 from the state machine — the audit row must not be written.

**Prompt (condensed):** Wire `AuditService.record()` into every state-changing method across Users, Projects, Tickets, and Dependencies. The rule: `record()` is always the last `await`, placed after the DB write. If anything earlier throws, the function exits before reaching the audit call. Write four e2e cases proving this: stale If-Match (412), missing If-Match (428), DONE-frozen ticket (409), and bad assigneeId on create (404). Assert zero rows in audit_logs after each of those failures.

**What the agent produced:** The retrofit across all services and a new `audit.e2e-spec.ts` with 20 cases, including the four failure-path cases.

**What I changed:** I specified in the prompt that the `before` snapshot — the entity state before any mutation — had to be captured immediately after the initial load, before the DONE-frozen guard, the If-Match check, or the state-machine call. The invariant is: if any of those guards throw, the snapshot is a local variable that dies with the stack frame; no audit row is ever reached. I also verified this placement in the code after the session because the commit message alone doesn't prove it — the reviewer can check `src/tickets/tickets.service.ts` and see `const before = { ...ticket }` on the line immediately after `findOne()`, before any guard.

---

### Mention diffing: prove the PKs don't change

**Context:** Session 7. The spec says "on comment update, diff the mention set — do not blindly re-insert." The implementation must be provably correct, not just claim to diff.

**Prompt (condensed):** For the mention-diff PATCH test, I need a test that captures bob's `Mention` row primary key before the PATCH and after the PATCH. The PATCH changes `@alice @bob` to `@bob @charlie`. Assert: alice's row is gone, charlie's row is new, and bob's row has the same primary key after the update as before. That test is the proof that the diff is real — if you delete-and-recreate, bob's PK changes.

**What the agent produced:** The test exactly as specified, plus the transactional diff implementation (existing = SELECT FROM mentions WHERE commentId, then set-diff in TypeScript, DELETE for removed, INSERT for added, unchanged rows untouched). The test passed on the first implementation pass.

**What I changed:** I also reviewed why the diff and the comment UPDATE were inside a single `dataSource.transaction()`. The agent's explanation — if the UPDATE commits but the INSERT fails, the mention rows forever disagree with the comment content and there's no error surface to detect it — satisfied me. I confirmed this was the correct place to use a transaction (unlike audit calls, where the data corruption is recoverable).

---

### Attachment MIME validation: magic bytes, not header

**Context:** Session 8. The spec requires rejecting disallowed MIME types on upload.

**Prompt (condensed):** Do not trust the client's `Content-Type` header for MIME validation. Implement a `MimeValidatorService` that reads magic bytes from the file buffer — PNG signature (8 bytes), JPEG (FF D8 FF), PDF (%PDF), text/plain (no NUL bytes, valid UTF-8 decode). Write a test that sends a JPEG file with `Content-Type: image/png` and asserts it is rejected because the magic bytes say JPEG but the claimed type says PNG.

**What the agent produced:** The magic-number validator with all four checks, plus the mismatch test. The text/plain check was particularly well-argued: no universal magic number exists for text files, so the implementation uses two rules — no NUL bytes (NUL signals binary content in Unix tools) and the buffer decodes as valid UTF-8 (`TextDecoder` with `fatal: true`).

**What I changed:** I reviewed the 400 vs 413 question for oversized files. The agent proposed 400 for everything size-related. I pointed out that multer's `LIMIT_FILE_SIZE` error maps to a `PayloadTooLargeException` (413) in NestJS before any of our code runs, and RFC 7231 specifies 413 for this case. The e2e test was updated to accept `[400, 413]` since both are technically defensible, but the comment documents that the actual implementation returns 413.

---

### Escalation: pure function split and the DONE ticket decision

**Context:** Session 9. The escalation scheduler is the most stateful background job in the system.

**Prompt (condensed):** Implement `escalateTicket(ticket, now): { newPriority, newIsOverdue, changed }` as a pure function — no DB, no Date.now(), caller always passes `now`. Write the unit tests first: null dueDate (no change), future dueDate (no change), LOW+overdue (→MEDIUM, isOverdue unchanged), HIGH+overdue (→CRITICAL, isOverdue still false), CRITICAL+overdue+flagged (no change, idempotent). Then the service: load candidates in ONE query. For the DONE-ticket question, pick one approach and document it — filter DONE at the DB load step, or let the conditional UPDATE fail. Either is acceptable; I want a clear rationale in the code comment.

**What the agent produced:** The pure function, 9 unit tests (all passing after first implementation), and a `runEscalationCycle()` service method that filters DONE at the load step with the rationale documented: "DONE tickets are frozen; escalating their priority violates the freeze rule. We filter at load time for efficiency and clarity rather than letting the conditional UPDATE silently skip them."

**What I changed:** The transaction wrapping the priority UPDATE and the audit INSERT was not in the first draft of the prompt — I added it after asking the agent to walk me through failure modes. The question was: if the priority UPDATE commits and the audit INSERT fails, what does an operator observe? The answer is: nothing. There is no error, no retry surface, no way to detect that a CRITICAL escalation happened without an audit row. That is worse than a failed escalation. Once I understood that, I required both operations to be wrapped in a single `dataSource.transaction()` per ticket, the same reasoning as the mention-diff transaction in Session 7. I also pushed back on the initial candidate-query filter: the first draft used raw SQL with `t."isOverdue"` (PostgreSQL quoted identifier) which would have failed at runtime. I required the condition to be expressed as TypeORM query-builder terms (`t.priority != :crit OR t.isOverdue = false`) so TypeORM handles the column-name mapping.

---

### Excluding `deletedAt` from responses

**Context:** Post-Session 10, during the run.md curl tour verification.

**Prompt (verbatim):** The project response includes a `"deletedAt": null` field that shouldn't be in the public API contract. Add `@Exclude()` from class-transformer to the `deletedAt @DeleteDateColumn` on both the Project and Ticket entities. Verify soft-delete still works end-to-end — soft delete a project, confirm it disappears from GET /projects, confirm the admin restore endpoint still works. Run the full e2e suite.

**What the agent produced:** The decorator added to both entities and the e2e suite re-run — which showed 8 failures, not 0.

**What I changed:** The 8 failures were not random; they fell into two categories. First, several tests in `projects.e2e-spec.ts` were explicitly checking `deletedAt` in responses, and one test assigned `projectId = res.body.id` *after* an assertion that threw — meaning `projectId` remained `undefined` and every subsequent test hit `DELETE /projects/undefined` (400 from `ParseIntPipe`). I required the assignment to be moved before any assertion. Second, the audit snapshot test asserted `after.deletedAt` was `null` (after restore), but `@Exclude()` causes `instanceToPlain()` on an entity instance to strip the field entirely, so the value was `undefined`. I reviewed whether the audit record needed `deletedAt` for correctness, concluded it did not (the action field and non-null `before.deletedAt` together prove a restore happened), and updated the assertion to `.toBeUndefined()`. All 153 e2e tests then passed.

---

## 4. Where the agent struggled — and what I did about it

### TypeORM @VersionColumn does not enforce optimistic locking on save()

This was the biggest incorrect assumption in the whole project. The agent's initial design for the PATCH route — use `@VersionColumn` and catch `OptimisticLockVersionMismatchError` — was based on the TypeORM documentation and what a reasonable engineer would expect the framework to do. I was skeptical, because "the framework catches concurrent writes" is a strong guarantee that I wanted to see proven, not assumed.

The concurrency test I directed the agent to write (described in section 3) confirmed the assumption was wrong. TypeORM 0.3.x `repo.save()` auto-increments `version` in the SET clause but does not include the original version in WHERE — so it silently overwrites a concurrent writer's commit. The catch block for `OptimisticLockVersionMismatchError` was dead code that would never execute.

The fix — two layers: explicit `If-Match` version check at entry, then atomic `UPDATE … WHERE id = ? AND version = ?` with `affected === 0` mapped to 412 — is more explicit than the framework-magic approach and easier to reason about. It also led to the discovery that the correct HTTP status for a missing `If-Match` is 428 Precondition Required, not 400, which is documented in run.md.

### The cascade failure in the projects e2e suite (hidden by deletedAt)

When I asked for the `@Exclude()` fix on `deletedAt`, the agent added the decorator and ran the suite. Eight failures appeared. The agent's first read of the failure output identified the `deletedAt` assertions but not the root cause of most of the 400 errors. The actual root cause was simpler: the "creates a project" test threw on the `deletedAt` assertion before assigning `projectId = res.body.id`, so `projectId` was `undefined` for the rest of the suite. Every subsequent test hit `DELETE /projects/undefined`, which `ParseIntPipe` correctly rejected with 400.

This is a testing pattern I have seen before: one assertion failure early in a test file produces a cascade of apparently unrelated errors in later tests, because shared test state was never set. The fix is always the same — capture shared state before asserting on it. I required the fix before accepting the commit. The broader lesson is that the root cause of a cascade is always in the first failure, not the loudest one.

### e2e tests passing in isolation but failing together (Session 5)

Adding the dependencies test suite in Session 5 revealed that Jest's default parallel-worker strategy was interleaving e2e suites that share the same Postgres database. A `TRUNCATE TABLE` in one suite's `beforeAll` was firing while another suite's test was mid-execution, corrupting its setup data. Both suites passed individually; both failed when run together.

The agent initially suggested adding `--runInBand` to the jest command, which would have solved the isolation problem but significantly slowed every future test run. I pushed back: the correct fix is `"maxWorkers": 1` in `test/jest-e2e.json`, which constrains parallel workers at the configuration layer so every developer and CI run gets the same behavior without a flag. The session log records this change and the reason. Total e2e runtime with `maxWorkers: 1` is approximately 6–7 seconds, which is acceptable.

### The @Cron decorator cannot read from the .env file

In Session 9, the prompt asked for the escalation cron schedule to be configurable via an `ESCALATION_CRON` environment variable. The agent's first suggestion was to read it from `ConfigService` in `onModuleInit` and register a dynamic cron job via `SchedulerRegistry`. That approach works but adds ~30 lines of boilerplate for a secondary config point.

I asked the agent to explain exactly when the `@Cron` decorator argument is evaluated. The answer revealed a real timing constraint: TypeScript evaluates decorator arguments at the point where the class is defined — when the module file is first imported by Node.js — which is before NestJS's bootstrap sequence has run `ConfigModule.forRoot()` and loaded the `.env` file. ConfigService is therefore unavailable at decoration time.

The options were: use `SchedulerRegistry` for dynamic registration (more correct, more code), or read directly from `process.env` (works when the variable is set in the OS environment before the process starts, documented limitation). I chose the second approach for this assignment and required that the limitation be clearly documented in both the code comment and `.env.example`. A reviewer who tries to set `ESCALATION_CRON` in `.env` and finds it ignored will find the explanation without digging into the source.



### "Tests pass" is necessary but not sufficient

Post-Session 10, during the run.md verification curl tour, I noticed that the project response body still contained `"deletedAt": null` despite an `@Exclude()` fix the agent had reported as committed and tested. I confirmed the commit on GitHub and the green test suite. Both were true. The bug was elsewhere: the running NestJS server was launched from a different cloned directory — the dry-run clone I'd made earlier to verify run.md from a reviewer's perspective — and that directory had not been pulled. The fix existed; my server just wasn't running it.
The lesson is not about the agent. It is about the verification surface. Tests prove the code in the test runner's working tree behaves correctly. They prove nothing about the code in any other process on the machine. End-to-end verification of the actual running endpoint — a curl against the live server, returning the live response body — is a separate check that catches a separate class of failure. After this I added the pattern of always re-running the curl tour from run.md after any change that touched a serialization boundary, regardless of test results.
---

## 5. Artifacts in this repo

**`CLAUDE.md`** — the project-memory file read by Claude Code at the start of every session. It encodes the stack constraints, the README as implementation contract, every hard business rule, and the workflow rules the agent follows (explain before committing, never invent endpoints, state assumptions in comments). It is committed and unchanged from Session 1 onward except for additions.

**`docs/session-log.md`** — the cumulative record of every session: declared goal, what was built, key design decisions and their rationale, test counts, files touched, and what to do next. It is the raw material from which this prompts.md was written, and it contains more detail on every decision than this document can. A reviewer who wants the full reasoning for any choice made in this codebase should read the relevant session entry there.
