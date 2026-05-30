# IssueFlow — Run Guide

## 1. Prerequisites

- **Node.js 20 or higher** — `node --version` should print `v20.x.x` or later
- **npm** — ships with Node.js 20; `npm --version` should print `10.x.x` or later
- **Docker Desktop** — must be installed AND running before you proceed.
  Launch Docker from Spotlight or Applications. Wait for the whale icon
  in the menu bar to stop animating (usually 10–30 seconds). Verify with:
```bash
  docker ps
```
  If you see a header row (with or without containers listed), Docker is up.
  If you see "Cannot connect to the Docker daemon," wait and retry.



No other tools are required.

---

## 2. Quick start

Clone the repo and enter the directory:
```bash
git clone https://github.com/SlowlyFire/IssueFlow.git
cd IssueFlow
```

Copy the environment template:
```bash
cp .env.example .env
```

Start Postgres in the background:
```bash
docker compose up -d
```

Verify Postgres is up (you should see the db service as "running" or "healthy"):
```bash
docker compose ps
```

Install dependencies:
```bash
npm install
```

Start the app in watch mode:
```bash
npm run start:dev
```

You should see `Nest application successfully started` in the logs. If you see this, the server is ready on `http://localhost:3000`.

**Keep this terminal open** — it shows the server logs and reloads on file changes. To run curl commands or other commands against the server, **open a second terminal** (`Cmd + T` for a new tab) and `cd` to the same project directory.


---

## 3. Environment variables

Copy `.env.example` to `.env` before starting. All variables ship with development defaults; the only one you'd ever change for a real deployment is `JWT_SECRET`.

| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST` | `localhost` | Postgres host |
| `DB_PORT` | `5432` | Postgres port |
| `DB_USERNAME` | `issueflow` | Postgres user |
| `DB_PASSWORD` | `issueflow` | Postgres password |
| `DB_NAME` | `issueflow` | Postgres database name |
| `JWT_SECRET` | `change-me-in-prod` | Secret used to sign JWTs. The default is intentionally weak so it's obvious in code review — change it for any real deployment. |
| `JWT_EXPIRES_IN` | `3600` | Token lifetime in seconds (1 hour). |
| `PORT` | `3000` | HTTP port the server listens on. |
| `UPLOADS_DIR` | `./uploads` | Directory where uploaded attachments are stored on disk. Created automatically on first upload. |
| `ESCALATION_CRON` | `*/15 * * * *` | Cron schedule for the priority-escalation job (standard 5-field format). See "Design decisions worth knowing" for the override gotcha. |

---

## 4. Verifying it works

Each command below is self-contained. Commands that depend on output from a previous step call out exactly which field to carry forward.

### Step 1 — Register an ADMIN user

```bash
curl -s -X POST http://localhost:3000/users \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "alice",
    "email": "alice@example.com",
    "fullName": "Alice Admin",
    "role": "ADMIN",
    "password": "password123"
  }' | jq .
```

Note: the README example body omits `password`, but the field is required — login needs it. See Design decisions below.

Expected response (status 200):

```json
{
  "id": 1,
  "username": "alice",
  "email": "alice@example.com",
  "fullName": "Alice Admin",
  "role": "ADMIN",
  "createdAt": "..."
}
```

### Step 2 — Log in and capture the token

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username": "alice", "password": "password123"}' \
  | jq -r .accessToken)
```

If you do not have `jq`, copy the `accessToken` string from the JSON output and set the variable manually:

```bash
TOKEN=<paste the value here>
```

Verify it captured:

```bash
echo $TOKEN
```

You should see a long `eyJ...` string.

### Step 3 — Create a project

Replace `1` below with the `id` returned in step 1 if it was different.

```bash
curl -s -X POST http://localhost:3000/projects \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Demo Project",
    "description": "My first project",
    "ownerId": 1
  }' | jq .
```

Note the `id` in the response — you need it for step 4.

### Step 4 — Create a ticket

Replace `<projectId>` with the `id` from step 3.

```bash
curl -s -X POST http://localhost:3000/tickets \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "Fix the login page",
    "type": "BUG",
    "priority": "HIGH",
    "projectId": <projectId>
  }' | jq .
```

The response includes `version: 1` and the server sets an `ETag: "1"` header. Any subsequent `PATCH` on this ticket must send `If-Match: "1"` (or the current version). Sending `PATCH` without `If-Match` returns `428 Precondition Required`.

---

## 5. Running the tests

### Unit tests (58 tests)

```bash
npm test
```

Expected output ends with `Tests: 58 passed, 58 total`. If the count differs, something is broken.

### End-to-end tests (153 tests)

The e2e suite requires the Postgres container to be running (`docker compose up -d`).

```bash
npm run test:e2e
```

The suite is configured with `maxWorkers: 1` — each test file runs serially so they do not race on the shared database. All 10 suites run in sequence. Total time is approximately 15–30 seconds.

Expected output ends with `Tests: 153 passed, 153 total`. If the count differs, something is broken.

---

## 6. Manual escalation trigger

The background cron promotes the priority of any ticket whose `dueDate` has passed (LOW → MEDIUM → HIGH → CRITICAL, then sets `isOverdue: true` at CRITICAL). It fires automatically every 15 minutes.

To trigger it immediately without waiting for the cron — useful for demos:

```bash
curl -s -X POST http://localhost:3000/admin/escalate-now \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Response:

```json
{
  "scanned": 5,
  "escalated": 2,
  "criticalMarked": 1
}
```

`scanned` is the number of candidate tickets examined; `escalated` is the number whose priority was promoted; `criticalMarked` is the number that were already at CRITICAL and had `isOverdue` set to `true`.

This endpoint requires an ADMIN token. A DEVELOPER token returns 403.

---

## 7. Database reset

To wipe all data and start fresh:

```bash
docker compose down -v
docker compose up -d
```

The `-v` flag removes the volume (all Postgres data). **Then restart the NestJS server** (Ctrl+C in the server terminal, then `npm run start:dev` again) — TypeORM's `synchronize: true` only recreates tables on startup, so the running server needs to be bounced to see the empty database.

---

## 8. Design decisions worth knowing

- **`password` is required on `POST /users`**, even though the README example body omits it. Login requires a password, so every user needs one at registration time. The field is hashed with bcrypt (10 rounds) before storage and never appears in any response.

- **`synchronize: true` is development-only.** TypeORM auto-migrates the schema on every startup. A production deployment would disable this and use explicit migration files.

- **`PATCH /tickets/:id` requires `If-Match`** carrying the ticket's current `version` (e.g., `If-Match: "3"`). The value is returned in every ticket response body as `version` and in the `ETag` response header. Missing `If-Match` → 428. Stale version → 412. This prevents lost-update races. `PATCH /tickets/:id/comments/:id` follows the same contract.

- **DONE status freezes a ticket entirely.** Once a ticket reaches `DONE`, no field — not title, not priority, nothing — can be updated. Attempting a PATCH returns 409. A ticket cannot be transitioned to DONE if any of its blockers are not themselves DONE.

- **`@username` mentions are case-insensitive.** `@Alice` and `@alice` resolve to the same user. Unknown `@names` are silently ignored — they are not an error. On comment update, only the diff (added and removed mentions) is persisted; unchanged mention rows are not touched, so their primary keys and `createdAt` timestamps are stable.

- **Attachments are stored on local disk** under `UPLOADS_DIR` (default `./uploads/`). The on-disk filename is a UUID — never the user-supplied name — to prevent path traversal. MIME type is validated against magic bytes in the file content, not the client-supplied `Content-Type` header. Allowed types: `image/png`, `image/jpeg`, `application/pdf`, `text/plain`.

- **The audit log writes outside transactions**, after the database save succeeds. The one exception is the comment mention diff (update + mention inserts/deletes are one transaction) and the escalation cycle (priority update + audit insert are one transaction). In those two cases, partial commit would leave the data silently inconsistent with no error surface for an operator to detect.

- **The token deny-list is in-memory** and resets when the process restarts. Tokens expire on their own after `JWT_EXPIRES_IN` seconds, so the effective security window is at most one hour. A production deployment would back this with Redis, keying on the token's `jti` claim with a TTL matching the remaining token lifetime.

- **CSV export** writes columns in this exact order: `id, title, description, status, priority, type, assigneeId`. Fields containing commas, double-quotes, or newlines are RFC-4180 quoted by `csv-stringify` — the file is safe to open in Excel and Google Sheets.

- **CSV import** validates each row independently. One invalid row does not abort the rest. The response body reports `{ created, failed, errors: [{row, error}] }` with 1-indexed row numbers.

- **ESCALATION_CRON** is read from `process.env` at startup, before dotenv loads — to override it for local runs, export it in your shell rather than setting it in .`env.`
---

## 9. Troubleshooting

**`Error: listen EADDRINUSE :::3000`**
Something else is already using port 3000. Find and stop it (`lsof -ti :3000 | xargs kill -9`), or change `PORT` in `.env` and restart.

**`ECONNREFUSED 127.0.0.1:5432` on startup**
The Postgres container is not ready yet. Run `docker compose up -d`, wait five seconds, then retry `npm run start:dev`.

**`Error: JWT_SECRET is required` (or app refuses to start with a config error)**
You did not copy `.env.example` to `.env`. Run `cp .env.example .env` and restart.

**`Port 5432 is already in use` when running `docker compose up`**
A local Postgres instance is running on your machine. Either stop it (`brew services stop postgresql` on macOS, or `sudo systemctl stop postgresql` on Linux) or edit `compose.yml` to publish a different port (e.g., `published: 5433`) and update `DB_PORT` in `.env` to match.
