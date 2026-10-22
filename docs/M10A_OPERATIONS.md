# M10-A operations runbook

Local implementation and verification only. No hosted environment has been provisioned or deployed. Live Qloo/Anthropic calls, purchases, public deployment, and external Git operations still require the owner's authorization. See M10A_VERIFICATION.md for actual results.

## Runtime and ingress

Run one instance of the image with its default `tini -- node scripts/start.mjs` entrypoint, `TL_ROLE=all`. Keep the distinct web UID 10001 and worker UID 10002. Do not replace the allowlisted child environment or forward `NODE_OPTIONS`, provider credentials, or migrator credentials to web. Preserve the worker-only Qloo home and its 0700 permissions.

`TL_WEB_MAX_OLD_SPACE_MB=512` and `TL_WORKER_MAX_OLD_SPACE_MB=768` are defaults, configurable from 128 through 16384 MB. These bound V8 old space, not total RSS; leave container headroom for native allocations, connections, the supervisor, and the harness. Watch memory pressure before changing these values.

Production requires `QLOO_MODE=live`, refuses `LLM_PROVIDER=scripted`, and requires database TLS. Both production and staging require exactly one `sslmode=require|verify-ca|verify-full` in the PostgreSQL URL. Conflicting `ssl` and `uselibpqcompat` options are rejected. Prefer verified certificates (`verify-full` and the provider's trusted CA) for hosted use. Configure TLS separately for the app and migrator roles. Development/test HTTP and local PostgreSQL remain supported.

`TRUSTED_PROXY_HOPS=0` is the secure default: supplied forwarding headers are ignored and unidentified clients share a conservative rate bucket. Set it to 1 only when a trusted ingress appends/overwrites the real peer address and **network policy prevents direct origin access**. For multiple proxies, configure the exact fixed suffix length and secure every hop. The application Request API has no authenticated peer socket to verify those assertions itself. Preserve the public `Host` header; CSRF never trusts `X-Forwarded-Host`. At the ingress, reject oversized request bodies and apply connection/request limits as defense in depth.

Before public access, demonstrate that changing the attacker-supplied leftmost XFF value does not change the bucket; direct origin access is blocked; alternate proxy paths cannot shorten the trusted chain; and HTTPS redirects, CSP nonces, HSTS, Secure cookies and share/sample no-store/noindex headers work at the hosted URL. These hosted checks have not run.

## Cost controls and access

`RUN_ACCESS` is shared by web and worker:

- `invite` is the staging/production default. Anonymous visitors can create/edit saved projects and browse published samples but cannot start AI work.
- `off` blocks new/resumed work and subsequent LLM reservations while saved views remain available. Changing environment configuration requires a controlled restart. A call already dispatched may still be billed.
- `open` is development/test default. Do not enable anonymous paid generation casually; it retains budgets but removes the invitation requirement.

Defaults: global LLM $15/day, workspace $3/day, experiment $5 total, plus each run's existing budget and the grant's lifetime cap. `MAX_ACTIVE_RUNS_PER_WORKSPACE=3`, `MAX_WORKING_RUNS=6`, `WORKSPACE_DAILY_RUNS=20`. Active workspace counts include human gates. Resuming a gate or retry rechecks access and concurrency. Manual retries are capped at three. Every provider attempt consumes durable per-run call/output allowances; crashes do not refund them. A reset of a state-machine usage snapshot cannot reset the spend ledger.

Run the bundled operator tool in a controlled terminal with the app database URL and the same share-token pepper as web. Keep output containing a newly created code private; do not put it in logs, chat, screenshots, shell arguments, or source control. For example, `node packages/db/dist/admin.mjs grant create --label judge-1 --days 14 --runs 10 --usd 5` prints one cryptographically random code; only its hash is stored. Other commands:

```text
node packages/db/dist/admin.mjs grant list
node packages/db/dist/admin.mjs grant revoke <grant-id>
node packages/db/dist/admin.mjs spend today
node packages/db/dist/admin.mjs sample list
node packages/db/dist/admin.mjs sample feature <share-link-id>
node packages/db/dist/admin.mjs sample unfeature <share-link-id>
```

An access code is reusable across workspaces, but all its workspaces share its lifetime run/spend caps. Revoke it if redistributed; issue a new separate grant for a new tester. Rotation of `SHARE_TOKEN_PEPPER` invalidates existing share tokens and code redemption hashes; revoke existing grants separately because already-redeemed workspaces reference grant IDs.

Public samples are explicitly featured, unexpired, unrevoked share links. Review the shared payload before featuring: the selected shared scope becomes public, including its creative content. Private projects are not automatically published. Unfeature or revoke the link to remove access. Sample requests read stored content and increment view counts; they do not start runs or call an AI provider. Fixture labels remain visible on synthetic content.

## Spending ledger and incidents

The gateway is the only paid generation entrypoint. SDK retries and server-side fallback are disabled; gateway repair, truncation retry and fallback each reserve separately before the call. Reservations atomically debit global/workspace/experiment/run/grant counters. Settlement adjusts all scopes once. Unknown billing, lost processes and failed settlement retain the entire reservation. An unrecognized serving model also retains its reservation and fails the request.

Reservations use checked-in model prices, prompt-byte/schema overhead at the highest input/cache rate, and the full output-token cap. This is a conservative local estimate, **not a verified provider-side billing ceiling**. Before any authorized live use, confirm model pricing and request behavior and configure a hard provider account spend limit. No real bill or live model behavior was verified in M10-A.

If observed billing exceeds a reservation, settlement records the actual amount and sets persistent global `llm_billing_overrun` (`day=total`). Further reservations fail closed. Do not delete this alarm, reduce usage counters, or refund RESERVED/UNKNOWN entries to regain capacity. First set `RUN_ACCESS=off`, inspect reservation metadata and the provider's billing evidence, correct the price/bound configuration, and obtain an explicit operator review before any manual reconciliation. Preserve the audit trail. Restoring an old database can lose newer spend reservations: keep paid work disabled after restore until reconciled against provider records and all pre-restore in-flight requests have ended.

Monitor `usage_counters` and `llm_spend_reservations` for budget consumption, UNKNOWN/old RESERVED entries, and the overrun alarm. Alert before caps are exhausted; cap rejection is expected safe behavior, not a reason to increase caps automatically. Run allowance/exhaustion responses keep saved projects usable. Do not log prompt payloads, access codes, workspace cookies, share URLs or raw provider responses.

## Release migrations and rollback

Use the separate DDL role only for `node packages/db/dist/migrate.mjs`, with `DATABASE_URL_MIGRATOR` from the secret store and `APP_ENV` matching the target. The release step must succeed before starting the new image. Runtime app credentials must have only the privileges described in `packages/db/sql/roles.sql`; never grant runtime DDL merely to bypass a migration failure.

Migrations 0000–0007 are forward-only. A PostgreSQL session advisory lock (`tessaloom:migrate`) serializes the entire Drizzle + pg-boss installation. Statement timeout is 120 seconds, lock wait 60 seconds. A dead migrator session releases the lock automatically. If a timeout occurs, inspect `pg_stat_activity`/locks through approved operator access; do not kill unrelated sessions. Retry the migrator after the prior release resolves. Drizzle migration transactions and idempotent queue installation make retries safe; verify all eight journal entries and queue installation afterwards.

Before release, record image digest, Git checkpoint, schema journal and configuration version without secrets. Take a backup. On failure, keep the last known healthy image and preserve evidence. **Do not roll back to a pre-WS-COST image while paid credentials are active**: it does not understand the guard, even though 0007 is additive at the schema level. Prefer a known hardened image; otherwise stop the worker and remove paid credentials through the secret manager before rollback. Never reset the ledger or downgrade the schema as a shortcut.

## Backup and recovery

Enable encrypted managed backups/PITR with at least seven days retention before hosted launch. Restrict access and test restores into a new database, never over the only copy. Use provider secret tooling or a private pgpass file for credentials; do not put URLs/passwords on command lines or in captured output.

For an approved backup: use `pg_dump --format=custom` against the intended database, record timestamp/schema/image metadata, and store the artifact in encrypted restricted storage. Restore with `pg_restore --exit-on-error --no-owner` into a newly created scratch database. Reapply least-privilege roles, verify the migration journal and critical row counts, run migrations if appropriate, then exercise a saved project/share in an isolated synthetic environment. Keep restored job workers stopped until queues and spending are reconciled; a restored queue must not replay paid jobs automatically.

The local container smoke performs a custom-format dump and restores it into a new database inside its disposable PostgreSQL container. It verifies the saved run state and migration count. This establishes local PostgreSQL tooling compatibility; managed-provider PITR, offsite storage, recovery-point/recovery-time targets and hosted restore procedures remain unverified.

## Health, logs and process recovery

`GET /api/health` is liveness only. `GET /api/health/ready` returns 200 only when the database answers and a job-consuming worker has a heartbeat younger than 30 seconds (database clock); otherwise 503. Use readiness for routing and alerting. A worker may take up to the heartbeat window to appear stale. Provider access/budget rejection should not take down read-only views. Synthetic container tests cover database outage → readiness 503 with liveness 200 → database recovery → readiness 200.

The supervisor restarts children with 1–30 second exponential backoff, exits after more than five crashes in five minutes, and forwards shutdown to child process groups with a 25-second grace period. Worker recovery uses committed state versions; cancelled/finished runs cannot reserve more spend. Keep unknown reservations charged. A worker restart is tested with the real supervised UID/PATH; no real provider calls are made.

Child stdout/stderr become JSON `child_log` records with role, stream and a redacted message. Redaction handles known secret values, encoded forms, URL credentials, bearer/API tokens, cookies and share tokens, including chunk boundaries. Lines longer than 16 KiB are omitted entirely to bound memory and avoid partial-secret exposure. V8 heap flags do not come from untrusted `NODE_OPTIONS`. Provider secrets remain worker-only. Redaction is defense in depth: producers must continue to avoid logging user/provider payloads.

Alert on readiness failure, repeated child restarts, migration failure, missing worker heartbeat, ledger errors/overruns, memory pressure and storage growth. Assign an operator and notification destination during M10-B; no external monitoring or notification service was configured here.

## Retention and remaining hosted work

Do not purge spend reservations, counters or grants while billing/recovery remains unresolved. Automatic pruning of expired shares, idempotency keys and old events is not implemented; storage growth needs monitoring and a separately reviewed retention policy. Existing pg 8 concurrent-query deprecation warnings remain; serialize the affected reads before any pg 9 upgrade.

M10-B still requires authorized hosting, secret provisioning, real ingress/TLS verification, provider hard limits/live validation, hosted backup/PITR drills, external monitoring, remote CI/CodeQL and the deployed cross-module journey. M11 is outside this task.
