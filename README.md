# Usage Metering and Quota Service

A backend service that lets applications meter how many **units** their users consume. Every request is checked against **two plans at once**: the shared plan of the **account** and the individual plan of the **user**. Units are consumed only if both plans allow the request. Decisions are idempotent, safe under concurrency, and stored permanently.

- TypeScript · Node.js 22 · Express 5 · PostgreSQL 17 (parameterized SQL via `pg`) · Zod
- Vitest + Supertest (61 tests against a real PostgreSQL)
- Docker Compose (db + api + example client), automatic migrations and seeding
- TypeScript CLI example client · k6 load tests with recorded results

---

## Contents

1. [Quick start](#quick-start)
2. [Architecture](#architecture)
3. [Domain model: accounts, users, plans](#domain-model-accounts-users-plans)
4. [Database schema and design decisions](#database-schema-and-design-decisions)
5. [Authentication, API keys and account isolation](#authentication-api-keys-and-account-isolation)
6. [Rules and evaluation order](#rules-and-evaluation-order)
7. [UTC monthly usage](#utc-monthly-usage)
8. [Plan updates and switches](#plan-updates-and-switches)
9. [Retries (idempotency) and concurrency](#retries-idempotency-and-concurrency)
10. [API reference](#api-reference)
11. [Example CLI client](#example-cli-client)
12. [Configuration](#configuration)
13. [Tests](#tests)
14. [Performance (k6)](#performance-k6)
15. [Product assumptions and tradeoffs](#product-assumptions-and-tradeoffs)
16. [Known limitations](#known-limitations)

---

## Quick start

```bash
cp .env.example .env          # optional: every value has a default
docker compose up --build
```

This starts three services:

| Service  | What it does                                                                                       |
|----------|----------------------------------------------------------------------------------------------------|
| `db`     | PostgreSQL 17, published on host port **55432** (avoids clashing with a local Postgres on 5432)     |
| `api`    | The API on **http://localhost:3000**. On startup it applies migrations and seeds predefined plans   |
| `client` | Waits until the API is healthy, runs the end-to-end demo once, prints every decision, then exits 0 |

No manual database step is needed. Startup order is enforced with health checks: `db` (`pg_isready`) → `api` (`GET /health`) → `client`.

```bash
docker compose run --rm client                 # run the demo again (creates a fresh demo account)
docker compose logs -f api                     # API logs
docker compose down                            # stop (data is kept in the pgdata volume)
docker compose down -v                         # stop and DELETE all data
```

---

## Architecture

```
            ┌──────────────┐   x-api-key    ┌─────────────────────────────────────────┐
 CLI / app ─┤ HTTP (JSON)  ├───────────────►│ Express app (src/http/app.ts)            │
            └──────────────┘                │  • auth middleware (hash lookup)         │
                                            │  • Zod validation (src/http/schemas.ts)  │
                                            │  • error mapping → {error:{code,...}}    │
                                            └──────────────┬──────────────────────────┘
                                                           │
                                            ┌──────────────▼──────────────────────────┐
                                            │ MeteringService (src/service.ts)         │
                                            │  accounts · keys · plans · users ·       │
                                            │  consume (transaction) · usage · history │
                                            └──────────────┬──────────────────────────┘
                                                           │ parameterized SQL (pg Pool)
                                            ┌──────────────▼──────────────────────────┐
                                            │ PostgreSQL: row locks, unique constraints,│
                                            │ monthly counters, immutable decisions    │
                                            └─────────────────────────────────────────┘
```

| Path                      | Purpose                                                                 |
|---------------------------|-------------------------------------------------------------------------|
| `migrations/001_init.sql` | Schema (tables, constraints, indexes)                                   |
| `src/db/migrate.ts`       | Migration runner (`schema_migrations` table + advisory lock)           |
| `src/db/seed.ts`          | Predefined plan seed (idempotent upsert with fixed UUIDs)               |
| `src/db/cli.ts`           | `npm run migrate`: migrate and seed without starting the API             |
| `src/service.ts`          | All business logic, including the consumption transaction              |
| `src/http/`               | Express app, routes, Zod schemas                                        |
| `src/server.ts`           | Entry point: config, auto-migrate/seed, listen, graceful shutdown       |
| `src/client/`             | Typed HTTP client, demo scenario, CLI                                   |
| `test/`                   | Vitest + Supertest suites (real PostgreSQL)                             |
| `load/k6/`                | k6 scripts; `load/results/` holds the recorded runs                      |
| `scripts/verify-consistency.ts` | Database-wide invariant check (used after load tests)             |

The API is stateless; all state lives in PostgreSQL. You can therefore run several API replicas behind a load balancer. Migrations take a Postgres advisory lock, so concurrent replica startups are safe.

---

## Domain model: accounts, users, plans

```
Plan (scope = account | user)
 ├─ predefined: owner = NULL, code = starter|pro|basic|premium, read-only
 └─ custom:     owner = one account, editable by that account only

Account ──(account_plan_id)──► Plan(scope=account)       1 account plan per account
   │
   └─ User ──(user_plan_id)──► Plan(scope=user)            1 user plan per user
```

- An **account** is a tenant (one customer application). It authenticates with API keys and has exactly one **account plan**. That plan's allowance is **shared** by all of the account's users.
- A **user** belongs to exactly one account and is identified by a client-chosen `userId` (e.g. `"alice"` or your own user ID). The ID is unique within the account. Each user has exactly one **user plan**.
- A **plan** is a reusable definition of limits: `monthlyAllowance` and `maxUnitsPerRequest`. Many users (or accounts, for predefined plans) can point to the same plan, and each one keeps **its own usage counter**.
- New accounts default to **Starter**, and new users default to **Basic**.

### Predefined plans (seeded, read-only)

| Code      | Scope   | Name    | Monthly allowance | Max units per request |
|-----------|---------|---------|------------------:|----------------------:|
| `starter` | account | Starter |            10,000 |                   500 |
| `pro`     | account | Pro     |         1,000,000 |                10,000 |
| `basic`   | user    | Basic   |             1,000 |                   100 |
| `premium` | user    | Premium |            20,000 |                 1,000 |

Predefined plans have fixed UUIDs (`00000000-0000-4000-8000-00000000a001` …), so references stay stable across environments. Wherever a `planId` is accepted, you can pass either the UUID or the code (`"premium"`).

### Custom plans

Accounts can create plans of either scope (`POST /v1/plans`), view them, and update them (`PATCH /v1/plans/:id`). A custom plan is visible only to its owner, and only the owner can assign it. Its name must be unique per owner and scope. The scope of a plan cannot change, and assignment checks the scope: assigning a `user` plan as an account plan, or the reverse, returns `422 plan_scope_mismatch`.

---

## Database schema and design decisions

| Table                    | Key columns / constraints                                                                                       |
|--------------------------|------------------------------------------------------------------------------------------------------------------|
| `plans`                  | `id` PK, `owner_account_id` (NULL = predefined), `code` (unique, predefined only), `scope` CHECK, limits CHECK ≥ 0/≥ 1, `version` |
| `accounts`               | `id` PK, `name`, `account_plan_id` FK → plans                                                                     |
| `api_keys`               | `id`, `account_id` FK, `key_prefix` (first 12 chars, for display), `key_hash` **UNIQUE** (SHA-256), `revoked_at` |
| `users`                  | `id` PK, `account_id` FK, `external_id`, `user_plan_id` FK, **UNIQUE(account_id, external_id)**                   |
| `account_monthly_usage`  | PK `(account_id, period)`, `used` CHECK ≥ 0. `period` = first day of the UTC month                             |
| `user_monthly_usage`     | PK `(user_id, period)`, `account_id`, `used` CHECK ≥ 0                                                            |
| `consumption_requests`   | `seq` BIGSERIAL PK, **UNIQUE(account_id, request_id)**, `user_id`, `units` CHECK > 0, `accepted`, `blocking_scope`, `blocking_rule`, `period`, `outcome` JSONB, `created_at`. CHECKs tie `accepted` to the blocking columns |

Design decisions:

- **Counters plus a decision log.** Monthly counters make every check O(1), with no `SUM()` over history. The decision log (`consumption_requests`) is the audit trail and the idempotency store. The invariant *account usage = Σ user usage = Σ accepted units* holds by construction because both counters move in the same SQL statement. The tests and `scripts/verify-consistency.ts` verify it.
- **Immutable outcome snapshot.** Each decision stores the complete response (limits in force, usage after the decision, reason) as JSONB. Retries and history return it verbatim, so later plan edits never rewrite past outcomes.
- **Usage keyed by period, not by plan.** Switching plans only changes a foreign key, so consumption can never be reset by a plan change.
- **Parameterized SQL rather than an ORM.** The consumption path relies on precise locking and data-modifying CTEs, which are clearest as hand-written SQL. Every query uses bind parameters.
- **Migrations run at startup** (`AUTO_MIGRATE=true`) inside a transaction per file, guarded by an advisory lock. The seed is an idempotent upsert that converges predefined plans to the definitions in `src/db/seed.ts`.

---

## Authentication, API keys and account isolation

### Provisioning (operator only)

New accounts are created by the **operator** of the service, not anonymously:

```bash
curl -X POST http://localhost:3000/v1/admin/accounts \
  -H 'x-admin-token: dev-admin-token-change-me' -H 'content-type: application/json' \
  -d '{"name": "Acme Corp", "planId": "starter"}'
```

```json
{
  "account": { "id": "7abf6269-…", "name": "Acme Corp", "createdAt": "…", "plan": { "code": "starter", "...": "…" } },
  "apiKey":  { "id": "…", "key": "umk_1rT0…<43 chars>", "prefix": "umk_1rT0xYzA", "createdAt": "…" }
}
```

- The admin token comes from `ADMIN_TOKEN` and is compared in constant time. An empty `ADMIN_TOKEN` disables provisioning (`503`). In production you would put this endpoint behind your internal network or a billing/sign-up backend, and set a long random token.
- The CLI wraps the endpoint: `ADMIN_TOKEN=… npm run client -- provision "Acme Corp"`.
- Accounts can then manage their own keys: `POST /v1/api-keys` (issue another key, for rotation), `GET /v1/api-keys` (prefixes only), `DELETE /v1/api-keys/:id` (revoke).

### API keys

- Format: `umk_` + 32 bytes from the OS CSPRNG (`crypto.randomBytes`), base64url-encoded (256 bits of entropy).
- **Only the SHA-256 hash is stored.** The plaintext key appears in exactly one response (creation) and is never persisted or logged. Because keys are high-entropy random secrets and not passwords, a fast deterministic hash is appropriate: brute force is infeasible, and it enables an indexed lookup (`key_hash UNIQUE`).
- Send the key in the **`x-api-key`** header. A missing key returns `401 missing_api_key`; an unknown or revoked key returns `401 invalid_api_key`.

### Isolation

The account ID comes **only** from the API key, never from the request body or URL. Every query is filtered by that account ID:

- Users are looked up by `(account_id, external_id)`. A `userId` from another account, even one with the same name, is simply `404 user_not_found`.
- Plans are visible only if predefined or owned by the caller. Another account's custom plan is `404` (its existence is not disclosed) and cannot be viewed, updated or assigned.
- Request IDs are scoped per account (`UNIQUE(account_id, request_id)`), so two tenants can never collide.
- History, usage and key listings are all filtered by account. `test/isolation.test.ts` covers each of these cases.

---

## Rules and evaluation order

One resource type ("units"). Each plan defines two rules, and both the account plan and the user plan apply to every request:

| Rule                    | Meaning                                                                                  |
|-------------------------|------------------------------------------------------------------------------------------|
| `max_units_per_request` | `units` must be ≤ the limit                                                              |
| `monthly_allowance`     | `consumed_this_UTC_month + units` must be ≤ the limit (so consuming exactly the limit is allowed) |

The evaluation order is **deterministic**. All four checks always run, and every failure is returned in `violations`. The **first** failure becomes `blockedBy`:

1. user `max_units_per_request`
2. account `max_units_per_request`
3. user `monthly_allowance`
4. account `monthly_allowance`

Rationale: per-request caps don't depend on accumulated usage, so they're reported first. Within each rule type, the narrower (user) scope comes before the shared (account) scope.

A request that violates **any** rule is rejected **as a whole**: neither counter changes (no partial consumption), and the rejection is stored. The response names the blocking rule and its scope:

```json
"blockedBy": { "scope": "account", "rule": "monthly_allowance", "limit": 1000, "requested": 400,
               "consumed": 880, "remaining": 120,
               "message": "Account monthly allowance of 1000 units would be exceeded (880 consumed, 120 remaining, 400 requested)" }
```

---

## UTC monthly usage

- Usage is assigned to the **UTC calendar month in which the server processes the request** (`period` = `YYYY-MM-01`), never to a client-supplied timestamp. For example, `2026-01-31T23:59:59.999Z` counts toward January and `2026-02-01T00:00:00Z` toward February.
- A new month needs no reset job. There is simply no counter row for it yet, so usage reads as 0. Past months stay in place and can be queried with `?month=YYYY-MM`. `GET /v1/usage/history` lists every month that has usage.
- `remaining = max(0, monthlyAllowance − consumed)`. If a plan change lowers the allowance below what has already been consumed, `remaining` is **0** and further requests are rejected.
- For a past month, `consumed` is the historical value, but `limits`/`remaining` are computed against the **currently assigned** plan. The limits that applied to each individual decision are preserved in that decision's stored `outcome`.

The tests inject a clock (`createApp({ now })`) to cross month and year boundaries deterministically (`test/usage-history.test.ts`).

---

## Plan updates and switches

| Operation                                    | Endpoint                         | Effect                                                                                |
|----------------------------------------------|----------------------------------|----------------------------------------------------------------------------------------|
| Switch account plan                          | `PUT /v1/account/plan`           | Account points to another account-scope plan. **Usage is untouched**                   |
| Switch user plan                             | `PUT /v1/users/:userId/plan`     | User points to another user-scope plan. **Usage is untouched**                         |
| Update a custom plan                         | `PATCH /v1/plans/:planId`        | New limits apply to **every** account/user assigned to it, from the next request on. `version` increments |
| Update a predefined plan                     | `PATCH /v1/plans/starter`        | `403 plan_read_only`                                                                    |

Semantics:

- Changes apply to requests whose transaction starts after the update commits. Updates and consumption take the same account row lock (see below), so a consume decision sees either the complete old plan or the complete new plan, never a mixture. This is tested in `test/concurrency.test.ts`.
- Past outcomes are **never rewritten**: each stored decision keeps the limits that were in force when it was made.
- Exact retries of an earlier request ID return the **original** outcome, even if the new limits would decide differently.

---

## Retries (idempotency) and concurrency

### Idempotency

Every `POST /v1/consume` carries a `requestId` that is unique **per account**.

| Situation                                              | Result                                                                                     |
|--------------------------------------------------------|---------------------------------------------------------------------------------------------|
| New request ID                                         | Evaluated, stored (accepted **or** rejected), `replayed: false`                              |
| Same request ID, same `userId` + `units`               | Original stored outcome returned, `replayed: true`, header `Idempotent-Replayed: true`, nothing consumed |
| Same request ID, different `userId` or `units`         | `409 idempotency_conflict`, with the original parameters in `details`                         |

Both accepted and rejected decisions are stored, so retrying a rejected request returns the same rejection even if quota has since become available. Clients that want a fresh evaluation send a new request ID. Validation failures (`400`) and unknown users (`404`) aren't decisions and aren't stored.

### Concurrency control

The consume transaction (`MeteringService.consumeTx`, READ COMMITTED):

```
BEGIN
1. SELECT … FROM accounts WHERE id = $acct FOR NO KEY UPDATE   -- per-account mutex
2. idempotency re-check (a duplicate may have committed while we waited)
3. ONE read: user, account plan, user plan, both monthly counters
   (a new statement after the lock is granted, so it sees all committed decisions)
4. evaluate rules in memory
5. ONE write (data-modifying CTE): upsert account counter + user counter by the same
   amount (only if accepted) and INSERT the decision row
COMMIT
```

- **Lock order is the same everywhere: account row first.** Plan switches (`account → user`) and custom-plan updates (`account → plan`) take the account lock before touching anything else, and custom plans can only be assigned within their owning account. Plan reads inside consume are therefore consistent, and there are no lock-order deadlocks.
- `FOR NO KEY UPDATE` (rather than `FOR UPDATE`) still allows concurrent inserts that only reference the account, such as creating users.
- **Safety nets:** `UNIQUE(account_id, request_id)` makes double-recording impossible even if the lock were bypassed. A unique violation is retried once and becomes a replay. CHECK constraints (`used >= 0`, `units > 0`) and a post-write comparison of the counters returned by `RETURNING` guard against inconsistent writes.
- **Fast path:** exact retries are answered from the decision table before taking any lock.
- **Proof:** the concurrency tests fire up to 120 simultaneous HTTP requests and assert that the shared allowance is never exceeded (exactly ⌊300/7⌋ = 42 accepted of 120), that duplicates are processed exactly once, and that the invariants hold. As a mutation check, removing the `FOR NO KEY UPDATE` clauses makes 5 of the 5 concurrency tests fail (overspending), which confirms the tests actually detect races.

Granularity tradeoff: serializing per account (rather than per user) is required for correctness, because every request also spends the shared account allowance. Different accounts never block each other.

---

## API reference

All bodies are JSON. Errors always have the shape `{"error": {"code": "...", "message": "...", "details": ...}}`. Request bodies are validated strictly: unknown fields, non-integer or non-positive units, and similar mistakes return `400 validation_error` with per-field `details`.

| Method | Path                              | Auth   | Description                                                   |
|--------|-----------------------------------|--------|---------------------------------------------------------------|
| GET    | `/health`                         | none   | Liveness + DB check → `{"status":"ok"}`                       |
| POST   | `/v1/admin/accounts`              | admin  | Create account (+ first API key)                              |
| GET    | `/v1/account`                     | key    | Calling account with its current plan                         |
| PUT    | `/v1/account/plan`                | key    | Switch account plan `{"planId"}`                              |
| GET    | `/v1/api-keys`                    | key    | List keys (prefix only)                                       |
| POST   | `/v1/api-keys`                    | key    | Issue an additional key                                        |
| DELETE | `/v1/api-keys/:keyId`             | key    | Revoke a key → 204                                             |
| GET    | `/v1/plans[?scope=account\|user]`  | key    | Predefined + own custom plans                                  |
| POST   | `/v1/plans`                       | key    | Create custom plan                                             |
| GET    | `/v1/plans/:planId`               | key    | View plan (UUID or predefined code)                            |
| PATCH  | `/v1/plans/:planId`               | key    | Update own custom plan (`name`, `monthlyAllowance`, `maxUnitsPerRequest`) |
| POST   | `/v1/users`                       | key    | Register user `{"userId", "planId"?}` (default plan Basic)     |
| GET    | `/v1/users[?limit&cursor]`        | key    | List users (keyset pagination by `userId`)                     |
| GET    | `/v1/users/:userId`               | key    | User with current plan                                         |
| PUT    | `/v1/users/:userId/plan`          | key    | Switch user plan `{"planId"}`                                  |
| GET    | `/v1/users/:userId/usage[?month]` | key    | User + shared account usage for a UTC month                    |
| POST   | `/v1/consume`                     | key    | Consume units (idempotent)                                     |
| GET    | `/v1/usage[?month=YYYY-MM]`       | key    | Account usage for a UTC month (default: current)               |
| GET    | `/v1/usage/history[?userId]`      | key    | All months with usage (account or one user)                    |
| GET    | `/v1/requests[?limit&cursor&userId&decision&month]` | key | Paginated decision history, newest first          |
| GET    | `/v1/requests/:requestId`         | key    | One stored decision                                             |

### Status codes

`200/201/204` success · `400 validation_error | invalid_json` · `401 missing_api_key | invalid_api_key | invalid_admin_token` · `403 plan_read_only` · `404 user_not_found | plan_not_found | request_not_found | api_key_not_found | not_found` · `409 idempotency_conflict | user_exists | plan_name_taken` · `422 plan_scope_mismatch` · `503 provisioning_disabled` · `500 internal_error`.

**A rejected consumption is `200`** with `"accepted": false`. The request was processed successfully, and the decision (stored and replayable) is a business outcome, not a transport error. Clients branch on `accepted`.

### Examples

**Create a custom plan**

```bash
curl -X POST localhost:3000/v1/plans -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"Team Shared","scope":"account","monthlyAllowance":1000,"maxUnitsPerRequest":500}'
```
```json
{"id":"5d0c…","code":null,"name":"Team Shared","scope":"account","predefined":false,
 "monthlyAllowance":1000,"maxUnitsPerRequest":500,"version":1,"createdAt":"…","updatedAt":"…"}
```

**Update it** (`PATCH /v1/plans/5d0c…` with `{"monthlyAllowance":5000}`) returns the plan with `"version":2`.

**Register a user and assign a plan**

```bash
curl -X POST localhost:3000/v1/users -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"userId":"carol","planId":"basic"}'
curl -X PUT  localhost:3000/v1/users/carol/plan -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"planId":"premium"}'
```
```json
{"userId":"carol","createdAt":"…","plan":{"id":"00000000-0000-4000-8000-00000000b002","code":"premium","name":"Premium","scope":"user","predefined":true,"monthlyAllowance":20000,"maxUnitsPerRequest":1000,"version":1,"createdAt":"…","updatedAt":"…"}}
```

**Consume** (real response captured from the running stack)

```bash
curl -X POST localhost:3000/v1/consume -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"userId":"carol","units":150,"requestId":"ex-2"}'
```
```json
{
  "requestId": "ex-2", "userId": "carol", "units": 150,
  "accepted": false, "decision": "rejected",
  "blockedBy": { "scope": "user", "rule": "max_units_per_request", "limit": 100, "requested": 150,
                 "message": "User plan allows at most 100 units per request; 150 requested" },
  "violations": [ { "scope": "user", "rule": "max_units_per_request", "limit": 100, "requested": 150, "message": "…" } ],
  "month": "2026-10", "processedAt": "2026-10-23T10:20:38.990Z",
  "account": { "planId": "00000000-0000-4000-8000-00000000a001", "planName": "Starter",
               "monthlyAllowance": 10000, "maxUnitsPerRequest": 500, "consumed": 42, "remaining": 9958 },
  "user":    { "planId": "00000000-0000-4000-8000-00000000b001", "planName": "Basic",
               "monthlyAllowance": 1000, "maxUnitsPerRequest": 100, "consumed": 0, "remaining": 1000 },
  "replayed": false
}
```

An accepted request has the same shape, with `"accepted": true`, `"blockedBy": null` and `"violations": []`. `consumed`/`remaining` are the values *after* the decision.

**Conflicting reuse of a request ID**

```json
HTTP/1.1 409
{"error":{"code":"idempotency_conflict","message":"Request id \"persist-1\" was already used with different parameters","details":{"original":{"userId":"p1","units":42}}}}
```

**User usage** (`GET /v1/users/p1/usage?month=2026-10`)

```json
{
  "month": "2026-10", "isCurrentMonth": true,
  "user":    { "userId": "p1", "plan": { "code": "basic", "...": "…" },
               "limits": { "monthlyAllowance": 1000, "maxUnitsPerRequest": 100 }, "consumed": 42, "remaining": 958 },
  "account": { "id": "7abf6269-…", "name": "persist-check", "plan": { "code": "starter", "...": "…" },
               "limits": { "monthlyAllowance": 10000, "maxUnitsPerRequest": 500 }, "consumed": 42, "remaining": 9958 }
}
```

`GET /v1/usage` returns the same `month`, `isCurrentMonth` and `account` fields. `GET /v1/usage/history` returns `{"months":[{"month":"2026-10","consumed":42}, …]}`.

**History** (`GET /v1/requests?limit=2`)

```json
{ "data": [ { "requestId": "ex-2", "decision": "rejected", "...": "full stored outcome" }, { "...": "…" } ],
  "nextCursor": "37561" }
```

Pass `cursor=<nextCursor>` for the next page. `nextCursor: null` marks the last page. The cursor is a keyset position, so requests that arrive while you paginate never shift or duplicate entries. Filters: `userId`, `decision=accepted|rejected`, `month=YYYY-MM`. `limit` is 1–200 (default 50).

---

## Example CLI client

`src/client/` contains a typed client (`api.ts`), the demo scenario (`demo.ts`) and a CLI (`cli.ts`).

**Run the demo**

```bash
docker compose up --build                     # runs automatically as the `client` service
docker compose run --rm client                # run it again
# or against a locally running API:
API_URL=http://localhost:3000 ADMIN_TOKEN=dev-admin-token-change-me npm run demo
```

The demo provisions a fresh account with a custom shared plan, **Team Shared** (1000 units/month, 500 per request), plus two users: **alice** on Basic and **bob** on Premium. It then runs these steps:

| # | Step                                                        | Decision | Reason shown                         |
|---|-------------------------------------------------------------|----------|--------------------------------------|
| 1 | alice 80                                                    | accepted |                                      |
| 2 | alice 150                                                   | rejected | `user / max_units_per_request`       |
| 3 | bob 400                                                     | accepted |                                      |
| 4 | bob 400                                                     | accepted |                                      |
| 5 | bob 400 (bob has 19,200 left, the account only 120)         | rejected | `account / monthly_allowance`        |
| 6 | retry of step 1 (same request ID)                           | accepted | replayed, nothing consumed           |
| – | `PATCH` Team Shared → 5000/month                            |          |                                      |
| 7 | bob 400 (same input as step 5, new request ID)              | accepted | plan update changed the decision     |
| – | `PUT` alice → Premium                                       |          |                                      |
| 8 | alice 150 (same input as step 2)                            | accepted | plan switch changed the decision     |

Each step prints the decision, the reason, and the remaining user and account allowance. At the end the demo checks that account usage (1430) = alice (230) + bob (1200), and it exits non-zero if any decision differs from what's expected. The plan changes go through the API at runtime; the decisions change without any client code change.

Excerpt from `docker compose up --build`:

```
client-1  | 5. bob requests 400 more: bob has plenty left, but the SHARED account allowance does not
client-1  |    -> REJECTED
client-1  |    reason: [account / monthly_allowance] Account monthly allowance of 1000 units would be exceeded (880 consumed, 120 remaining, 400 requested)
client-1  |    remaining: user bob 19200/20000 (Premium), account 120/1000 (Team Shared)
...
client-1  | DEMO OK: every decision matched expectations
client-1 exited with code 0
```

**Other CLI commands** (`npm run client -- <command>`, or `docker compose run --rm client node dist/src/client/cli.js <command>`):

```bash
export API_URL=http://localhost:3000 ADMIN_TOKEN=dev-admin-token-change-me
npm run client -- provision "My App"                        # prints the API key once
export API_KEY=umk_...
npm run client -- add-user alice basic
npm run client -- consume alice 10                          # random requestId
npm run client -- consume alice 10 my-request-1             # explicit requestId (retry-safe)
npm run client -- create-plan user Gold 5000 200
npm run client -- set-user-plan alice <planId|code>
npm run client -- update-plan <planId> 8000
npm run client -- usage alice 2026-10
npm run client -- history alice 20
```

---

## Configuration

See `.env.example`. Docker Compose reads `.env` automatically. Every variable has a default.

| Variable             | Default                                   | Used by                                     |
|----------------------|-------------------------------------------|---------------------------------------------|
| `POSTGRES_USER/PASSWORD/DB` | `metering` / `metering` / `metering` | db container + API `DATABASE_URL`         |
| `POSTGRES_HOST_PORT` | `55432`                                   | host port for PostgreSQL                    |
| `API_HOST_PORT`      | `3000`                                    | host port for the API                       |
| `ADMIN_TOKEN`        | `dev-admin-token-change-me`               | provisioning endpoint (empty = disabled)    |
| `DB_POOL_MAX`        | `20`                                      | API connection pool size                    |
| `LOG_REQUESTS`       | `false`                                   | one log line per request                    |
| `DATABASE_URL`       | `postgres://metering:metering@localhost:55432/metering` | API outside Docker            |
| `AUTO_MIGRATE`       | `true`                                    | migrate + seed on API startup               |
| `TEST_DATABASE_URL`  | `postgres://metering:metering@localhost:55432/metering_test` | tests                     |
| `API_URL`, `API_KEY` | `http://localhost:3000`, –                | CLI client                                  |

**Running the API without Docker** (still needs a PostgreSQL):

```bash
npm ci
docker compose up -d db                # or point DATABASE_URL at any Postgres
npm run migrate                        # optional; the API also does this at startup
ADMIN_TOKEN=secret npm run dev         # tsx watch
npm run build && npm start             # compiled
```

---

## Tests

```bash
docker compose up -d db     # tests need PostgreSQL (host port 55432)
npm ci
npm run typecheck
npm test
```

The test global setup **drops and recreates** the `metering_test` database (never the main `metering` database), then migrates and seeds it. The tests then talk to the real PostgreSQL through Supertest, plus a real HTTP listener for concurrency and client tests.

Latest run: **9 files, 61 tests, 61 passed, 0 failed** (about 11–17 s depending on machine load).

| File                          | Covers                                                                                       |
|-------------------------------|----------------------------------------------------------------------------------------------|
| `auth.test.ts`                | Provisioning + admin token, key format and uniqueness, only the hash stored, missing/invalid/revoked keys, key rotation, malformed JSON |
| `isolation.test.ts`           | Cross-account users/plans/keys/history/usage, per-account request IDs, same `userId` in two accounts |
| `plans.test.ts`               | Seeded plan limits, read-only predefined plans, custom create/view/update, validation, scope checks, defaults, switching, shared plan with independent usage, user pagination |
| `consume.test.ts`             | Each rule at each scope, exact boundaries, shared allowance, no partial consumption, stored rejections, evaluation order, input validation |
| `idempotency.test.ts`         | Accepted and rejected replays (also after a limit change), 409 conflicts, 20 concurrent duplicates processed once |
| `concurrency.test.ts`         | 120 concurrent requests vs a shared allowance, hot single user, two accounts in parallel, plan update during a burst, mixed burst with duplicate retries |
| `plan-changes.test.ts`        | Switches keep usage, downgrade below usage → remaining 0 + rejection, plan update affects all assignees, stored outcomes never change |
| `usage-history.test.ts`       | UTC month/year boundaries (injected clock), offsets vs UTC, past months queryable, usage history, effective limits, keyset pagination stability, history filters |
| `client.test.ts`              | Runs the real demo client against the app: decisions, reasons, remaining values, final totals, error surfacing |

---

## Performance (k6)

### How to run

k6 runs from its official Docker image, so nothing needs installing (a local `k6 run load/k6/...` works too):

```bash
docker compose up -d --build
# Overspend race: 100 VUs, 3000 requests of 1 unit each against a 1000-unit shared allowance
docker run --rm --user "$(id -u)" --network host -v "$PWD/load:/load" grafana/k6:1.0.0 \
  run --summary-export /load/results/quota-race-summary.json /load/k6/quota-race.js
# Throughput: 50 VUs × 30 s over 10 accounts, then 50 VUs × 30 s on a single account; ~5% idempotent retries
docker run --rm --user "$(id -u)" --network host -v "$PWD/load:/load" grafana/k6:1.0.0 \
  run --summary-export /load/results/throughput-summary.json /load/k6/throughput.js
# Afterwards: database-wide invariant check
npm run verify:consistency
```

k6 summary exports include `setup()` data, which contains the throwaway API keys of the load-test accounts. Redact them before committing:
`sed -i -E 's/umk_[A-Za-z0-9_-]{43}/umk_<redacted>/g' load/results/*.json`

Tunables (`-e NAME=value`): `API_URL`, `ADMIN_TOKEN`, `VUS`, `DURATION`, `ACCOUNTS`, `USERS_PER_ACCOUNT` (throughput); `VUS`, `ALLOWANCE` (race). Both scripts provision their own accounts in `setup()`, check invariants in `teardown()`, and fail through thresholds (`checks rate==1.0`, `http_req_failed`, p95 latency).

### Measured results

**Environment (all on one machine, so k6, the API and Postgres compete for CPU):** WSL2 Linux 6.18, 8 vCPU, 7 GB RAM, Docker 29.8.2, k6 1.0.0, Node 22 (one API process, pool of 20), Postgres 17 with default config. Raw outputs are in `load/results/` (`*.txt` k6 stdout, `*-summary.json` k6 summaries; `baseline/` holds the run before the optimization described below).

| Scenario (final build)                          | Requests | Throughput | Latency avg / p50 / p90 / p95 / max            | HTTP errors |
|-------------------------------------------------|---------:|-----------:|------------------------------------------------|------------:|
| `multi_account`: 50 VUs, 10 accounts, 30 s      | 8,016    | ~267 req/s | 187 / 167 / 277 / **337** / 907 ms              | 0.00 %      |
| `single_account`: 50 VUs, 1 account, 30 s       | 4,262    | ~142 req/s | 353 / 356 / 411 / **457** / 570 ms              | 0.00 %      |
| `quota-race`: 100 VUs, 1 account, 3,000 iterations | 3,025 (incl. setup) | ~118 req/s | 825 / 806 / 969 / **1,020** / 1,360 ms | 0.00 %      |

A second run during the pre-submission audit, on the same build and machine with the same scripts (`load/results/rerun/`), measured somewhat better numbers. Expect noticeable run-to-run variance on a shared developer machine:

| Scenario (audit re-run)                         | Requests | Throughput | Latency avg / p50 / p90 / p95 / max            | HTTP errors |
|-------------------------------------------------|---------:|-----------:|------------------------------------------------|------------:|
| `multi_account`: 50 VUs, 10 accounts, 30 s      | 9,751    | ~325 req/s | 154 / 144 / 212 / **244** / 555 ms              | 0.00 %      |
| `single_account`: 50 VUs, 1 account, 30 s       | 5,090    | ~170 req/s | 296 / 306 / 331 / **339** / 388 ms              | 0.00 %      |
| `quota-race`: 100 VUs, 1 account, 3,000 iterations | 3,025 (incl. setup) | ~156 req/s | 623 / 597 / 738 / **765** / 985 ms   | 0.00 %      |

The re-run's correctness results matched the first run: race 1000 accepted / 2000 rejected (no overspend); account usage = Σ user usage for all 10 throughput accounts; `verify:consistency` OK (17,126 decisions).

Correctness under load (from the k6 `teardown` checks and `verify:consistency`):

- **Quota race:** exactly **1000 accepted, 2000 rejected**, account consumed = 1000 = Σ users, remaining 0. **No overspend.**
- **Throughput run:** all checks passed (100 %). For every one of the 10 accounts, account usage = Σ user usage. 11,711 fresh accepted decisions and 567 idempotent replays.
- `verify:consistency` over the entire database after all runs: *"checked 45 account-months; decisions=37560 accepted=33556 — OK: account usage == sum(user usage) == sum(accepted units) for every account-month"*.

### Bottleneck analysis

1. **Single hot account → the per-account row lock (by design).** With all VUs on one account, Postgres sessions spend nearly all their time in `Lock:tuple` (sampled from `pg_stat_activity` during the run: 174 of 197 samples). Decisions for one account are strictly serial, so throughput ≈ 1 / (lock hold time), and the latency of 50–100 concurrent clients is mostly queueing (p95 ≈ VUs × hold time). This is the price of exact, never-overspend quotas on a shared allowance.
2. **Lock hold time = DB round trips.** The first implementation used ~10 statements while holding the lock. Reducing it to lock → 1 read → 1 write → commit (data-modifying CTE) and answering replays without a lock improved the measured results (same scripts, same machine):

   | Scenario         | Before (requests / p95) | After (requests / p95) |
   |------------------|-------------------------|------------------------|
   | `single_account` | 2,964 / 771 ms          | 4,262 / 457 ms (+44 %) |
   | `multi_account`  | 6,974 / 359 ms          | 8,016 / 337 ms (+15 %) |

3. **Many accounts → the single Node.js process.** In the multi-account phase the API container ran at **~106 % CPU** (one core saturated), and the most common Postgres wait was `Client:ClientRead`, meaning the database was waiting on the application. Lock waits were secondary. Since the API is stateless, the next step is horizontal: more API replicas, or Node cluster mode. Per-request costs like the API key hash lookup could be cached briefly.
4. **Environment ceiling.** A trivial `GET /health` (one `SELECT 1`) peaked at ~1,250 req/s on this machine, measured with the same k6 setup. That bounds what any endpoint can reach here, so absolute numbers on dedicated hardware will be considerably higher.

Possible further improvements, not implemented: move the decision into a single PL/pgSQL function (one round trip); add API replicas; use pgbouncer; cache key→account lookups for a few seconds; or, if a product allows bounded overspend, pre-allocate per-user slices of the account allowance to avoid the shared lock.

---

## Product assumptions and tradeoffs

- **Single resource type**, integer units. Units per request are capped at 10¹² by validation, so all arithmetic stays exact within JS numbers and Postgres `bigint`.
- **The user ID is client-chosen** (`userId`, unique per account). Users must be registered before they consume; an unknown user gets `404`, and the call isn't stored as a decision.
- **Rejected decisions are final for their request ID.** A retry returns the rejection; a new attempt needs a new request ID.
- **Rejection = HTTP 200 with `accepted:false`**, because it's a successfully processed, stored decision (see the API reference).
- **Plan changes take effect immediately** for new requests within the current month. There's no proration and no scheduling of future changes.
- **Past-month `remaining`** is computed against the currently assigned plan; the exact historical limits live in each stored decision.
- **Exact quotas over raw throughput:** per-account serialization guarantees never overspending a shared allowance, at the cost of a per-account throughput ceiling (see Performance).
- **Accounts are provisioned by an operator** using a static admin token. Account owners then self-manage keys, plans and users.
- **SHA-256 (no salt)** for API keys, because they're random 256-bit secrets. Password-style KDFs (bcrypt/argon2) would add latency to every request without a security benefit here.

---

## Known limitations

- The API can't delete users, custom plans or accounts (keys can only be revoked).
- No rate limiting, request-size limits beyond 32 kB bodies, or brute-force protection on the auth endpoints.
- The admin token is a single static shared secret: no admin roles, audit log or rotation endpoint.
- The history cursor is the global `seq` value. It's opaque to clients but reveals approximate global request volume, and it isn't signed.
- History responses come from JSONB, so object key order can differ from the original response (the JSON value is identical).
- The decision log grows forever: there's no retention/archival policy or partitioning by month.
- Throughput on a single hot account is limited by the per-account lock (~140 req/s measured on the test machine above).
- Plan updates don't keep version history (only a `version` counter). Each decision does snapshot the limits it used.
- Measurements were taken on a shared developer machine (WSL2), with the load generator on the same host. Treat them as relative numbers, not capacity planning figures.
