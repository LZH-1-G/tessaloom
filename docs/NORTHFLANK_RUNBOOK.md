# Northflank production recovery

Status: local repair preparation, 2026-10-25 Beijing time. Northflank is the selected platform.
This runbook supersedes M11's hosting recommendation for this deployment. Reuse the existing
`lzh's team` → `Default` project/environment → `tessaloom` service and `tessaloom-db` addon,
US-Central (Council Bluffs). Do not create another database, publish a port, upgrade a plan,
or run production migrations merely by following a local test command.

## 1. Record the current deployment before changing it

The October 24 incident report is historical evidence: build and web startup succeeded,
`/api/health/ready` returned HTTP 503 with `{"db":true,"worker":false}`, and the worker
logged `worker_queue_start_failed` with only `name: Error`. This proves DB connectivity
and absence of a fresh accepted heartbeat, not the precise remote queue failure.

Local starting commit was verified against remote main: `47063389ca83090ad85a0ebc9d8592736d28e3aa`.
Its six CI jobs passed; CodeQL was skipped for the private repository. Check the repair PR
for its current CI results; local evidence is recorded separately in NORTHFLANK_VERIFICATION.md.
No Northflank connector is available in this session, and native Chrome inspection timed out.
The current image, port visibility, variables, latest instance logs and readiness remain unverified.

In the Northflank UI, select the service and record, without copying secrets:

1. Deployed commit/build ID, image digest, deployment timestamp and **latest instance ID**.
2. Current instances versus rollout instances; do not combine an old pod's errors with a new pod's health.
3. Docker source `/Dockerfile`, context `/`, command and entrypoint overrides (if any).
4. Resources: reported `nf-compute-20`, 0.2 shared vCPU, 512 MiB, one instance.
5. `Configure → Networking`: port 3000 HTTP and its actual visibility. Keep it private during recovery.
6. Readiness: HTTP `/api/health/ready`, port 3000, initial delay 60 s, interval 20 s,
   timeout 5 s, failure threshold 5, success threshold 1. Keep this path and the 503 semantics.
7. Secret-group restrictions and variable **names only**. A service-level value overrides a group value.
8. Addon PostgreSQL 16, TLS enabled, private networking, 6 GB disk, current health and backup state.

Before the repaired diagnostic binary is available, this **read-only** command can run in
the latest existing service's `/app` shell. It reads the existing connection privately and prints
only booleans. It does not migrate or call providers. Never run `env`, `printenv`, `echo $DATABASE_URL`,
or copy raw database errors, connection details or secret screens into a report.

```sh
node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
const require = createRequire('/app/apps/web/server.js');
let client;
try {
  const pg = require('pg');
  const url = new URL(process.env.DATABASE_URL);
  const modes = url.searchParams.getAll('sslmode');
  if (modes.length !== 1 || !['require','verify-ca','verify-full'].includes(modes[0]) ||
      url.searchParams.has('ssl') || url.searchParams.has('uselibpqcompat')) throw Error();
  url.searchParams.set('sslmode','verify-full');
  client = new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000,statement_timeout:5000});
  client.on('error',()=>{});
  await client.connect();
  const {rows} = await client.query(`SELECT
    to_regclass('public.worker_heartbeats') IS NOT NULL AS heartbeat_table,
    to_regclass('public.prompt_templates') IS NOT NULL AS prompt_table,
    to_regclass('public.llm_spend_reservations') IS NOT NULL AS cost_table,
    to_regclass('pgboss.version') IS NOT NULL AS queue_version_table,
    to_regclass('pgboss.queue') IS NOT NULL AS queue_table,
    (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS elevated_role,
    has_schema_privilege(current_user,'public','CREATE') AS public_ddl
    FROM pg_roles WHERE rolname=current_user`);
  console.log(JSON.stringify({event:'database_catalog_check',...rows[0]}));
} catch { console.log(JSON.stringify({event:'database_catalog_check_failed'})); process.exitCode=1; }
finally { await client?.end().catch(()=>{}); }
NODE
```

After the new image is deployed privately, use the built-in diagnostic instead:

```sh
node packages/db/dist/diagnose.mjs
node -e "fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(4500)}).then(async r=>console.log(r.status,await r.text())).catch(()=>{console.log('probe_failed');process.exitCode=1})"
```

`diagnose.mjs` is read-only and never starts a queue consumer. Exit 1 means checks failed or
runtime credentials have elevated/CREATE privileges; use the reported booleans to choose the
next step. It checks application/queue tables, required queues, TLS and DML rights. It does not
prove every migration's content or pg-boss version compatibility; the release migration and
actual worker startup provide those checks.

## 2. Separate database administration, migrations and runtime

**Do not link the addon's administrator `POSTGRES_URI` to the app's `DATABASE_URL` permanently.**
The historical link's actual role privileges are unknown until inspected. Keep addon admin
credentials restricted to an operator session/job; never give them to web or worker.

Create/reuse these runtime-only restricted groups (never build arguments):

| Group purpose            | Allowed recipient                          | Contents                                                                                        |
| ------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| App database             | `tessaloom` only                           | `DATABASE_URL`, for DML-only `tessaloom_app`, TLS hostname verification                         |
| App security             | `tessaloom` only                           | Existing stable `SESSION_SECRET` and `SHARE_TOKEN_PEPPER`, each at least 32 characters          |
| Provider credentials     | `tessaloom` only, when separately approved | Provider keys injected into root supervisor; its allowlist passes them only to worker UID 10002 |
| Release database         | Migration job only                         | `DATABASE_URL_MIGRATOR`, schema-owner credential; `APP_ENV=production`                          |
| Bootstrap administration | Temporary operator operation only          | Existing addon admin access and private new role passwords; never linked to the service         |

Preserve existing session secret/pepper; changing the pepper invalidates stored grants/shares.
Do not configure `DATABASE_URL_MIGRATOR`, `POSTGRES_URI`, addon admin passwords, or other
unnecessary secrets on the service. Remove the old unrestricted inherited group once the
DML-only URL is configured. Use the managed private hostname/port/database unchanged, change
only the credentials and reviewed TLS mode. URL-encode password characters. Prefer
`sslmode=verify-full`; repaired code also normalizes `require`/`verify-ca` to the same certificate
and hostname verification already used by the pinned pg 8 driver. Do not use `sslmode=disable`,
`ssl=false`, `uselibpqcompat=true`, or `NODE_TLS_REJECT_UNAUTHORIZED=0`.

For a **confirmed empty application database**, after backup and explicit production-change
approval, run [northflank-roles.sql](../deploy/northflank-roles.sql) through a private `psql`
session as the existing addon administrator. It reads `TL_MIGRATOR_PASSWORD` and
`TL_APP_PASSWORD` from that session's secret environment; enter these through Northflank's
restricted secret UI, not chat, shell history or `psql -v password=...`. This file is deliberately
not an automatic entrypoint: it creates two restricted roles, grants schema creation only to
migrator, DML defaults to app, and refuses populated databases/existing roles rather than
reassigning ownership. The local resource smoke executes this exact script on a fresh test cluster.

If any application tables/roles already exist, **do not run the empty-database bootstrap**.
Inspect ownership in a private administrator session first. Reuse the actual schema-owning
migration role for existing objects. To repair missing runtime grants, the owner/admin can run:

```sql
BEGIN;
GRANT USAGE ON SCHEMA public, pgboss TO tessaloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, pgboss TO tessaloom_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, pgboss TO tessaloom_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO tessaloom_app;
COMMIT;
```

Also configure matching default privileges **for the actual future migration owner** as in
`northflank-roles.sql`. Do not grant ownership, CREATE, SUPERUSER, CREATEROLE, BYPASSRLS,
TRUNCATE or membership in the migration role to `tessaloom_app`. If objects have mixed owners,
stop and prepare an explicit ownership repair; neither this runbook nor the worker changes ownership.

## 3. Release migration must finish before serving the image

The production Docker CMD starts the supervisor, **not** `deploy/app-entrypoint.mjs`.
The latter expects the local Compose `/run/secrets` layout and fixed `postgres` hostname;
do not use that wrapper on Northflank. Do not append migrations to the app's start command.

After approval to publish/release the local repair:

1. Keep the existing service private and `RUN_ACCESS=off`. Disable automatic deployment (CD)
   while arranging migration ordering; pushing to connected main can otherwise deploy immediately.
   The repair branch and PR are authorized for publication; merging, CD changes and production
   deployment require separate approval and have not been performed by this repair task.
2. Create/reuse a **one-off job**, in the same project and environment, named
   `tessaloom-migrate`, from the **exact reviewed app image/build**. Verify its displayed cost
   stays within the existing Sandbox entitlement; stop for approval if it would be billable.
3. Runtime command override: executable `node`, arguments
   `--max-old-space-size=192 packages/db/dist/migrate.mjs` (array elements if using JSON:
   `["node","--max-old-space-size=192","packages/db/dist/migrate.mjs"]`). Keep image entrypoint
   `tini -s --`. Working directory `/app`. No port, no schedule, no provider/security secrets.
   Link only the restricted release group. Use an available Sandbox job resource plan
   with at least 384 MiB (the local release test cap); 512 MiB provides additional headroom.
4. Take an addon backup before the job. Record its ID/time and recovery procedure privately.
   Confirm the backup feature/cost in this account before enabling any paid backup storage.
5. Run once and require exit 0 plus `migrations_applied`. Eight application migrations plus
   pg-boss schema and the three queues are installed. Re-running is supported and uses the
   migration advisory lock; a failed job is a deployment blocker, not a reason to grant runtime DDL.
6. A pipeline/release flow must depend on successful job completion before deploying/promoting
   that same build to the existing `tessaloom` service. Do not configure job and app as parallel
   siblings. Direct app CD must stay off if it bypasses this flow. A manual job-then-deploy sequence
   is acceptable for this recovery if the free plan UI cannot configure the dependency.
7. Stop on `migrations_failed`: use the fixed reason (`permission_denied`, `relation_missing`,
   `tls_untrusted`, etc.). The job never prints SQL, passwords or raw errors. Existing DB data
   and the forward-only migrations are preserved.

## 4. Exact application configuration

Use [northflank.env.example](../deploy/northflank.env.example) as the non-secret runtime settings.
It deliberately selects DeepSeek economy mode but leaves paid execution disabled. Keep provider
keys absent until explicitly authorized. Missing `QLOO_API_KEY` makes local Qloo credential
readiness false; missing `LLM_PROVIDER` defaults to Anthropic, missing `LLM_MODE` to standard,
and missing provider key gives an unconfigured gateway. None causes `pg-boss is not installed`.
Qloo diagnostics run `qloo --version` and `qloo doctor --json` **without `--network`**; queue
startup no longer waits for these local diagnostics.

- Source: existing repo, reviewed commit on main only after approved merge, `/Dockerfile`, `/` context.
- No command override: image `CMD ["node","scripts/start.mjs"]`, `ENTRYPOINT ["tini","-s","--"]`.
- Image starts root supervisor, which drops web to UID/GID 10001 and worker to 10002.
  Do not override the whole container to a single shared UID. Do not bypass supervisor with Next directly.
- One instance, 512 MiB / 0.2 vCPU for the first private recovery attempt. Explicit old-space caps:
  web 128 MiB, worker 192 MiB. V8 caps are not total RSS limits; include supervisor, native buffers
  and Qloo harness processes in the memory graph. Request concurrency is limited to one paid run,
  and all budgets remain zero. This profile is not acceptance for a real provider workload.
- Shutdown grace at least 35 seconds if configurable. Tini subreaper mode handles platforms that
  wrap the entrypoint. Worker startup/stop are serialized and pending retries are cancelled.
- Keep readiness settings from step 1. A separate liveness probe may use `/api/health`; it must
  not replace readiness. Never force readiness to 200 or point it at a web-only page.
- Keep port 3000 private. `TRUSTED_PROXY_HOPS=0` uses a conservative shared-edge rate-limit
  identity until Northflank's header chain is verified. Do not raise it based on a guessed hop count.

Before each heartbeat the worker rechecks queue schema version, required definitions and runtime
queue permissions. A failure stops renewal; readiness turns 503 within the existing 30-second
freshness window and recovers when capability returns.

The supervisor generates one UUID per colocated web/worker pair. `/api/health/ready` uses that
identity, so a still-running old pod cannot make a broken new pod appear ready. Standalone
`TL_ROLE=web`/`worker` deployments retain shared-heartbeat compatibility; this runbook uses `all`.

## 5. Acceptance and logs

Choose **one latest deployment instance** and confirm:

1. `child_start` web and worker, without repeated exits or `crash_limit`.
2. `worker_queues_started`; a missing provider is allowed for infrastructure validation.
3. `database_diagnostic`: TLS true, elevated false, schemaCreate false, required checks true.
4. Direct Node probe returns HTTP 200 and exactly `{"db":true,"worker":true}`.
5. Northflank readiness shows 1/1, stable for at least 10 minutes, no OOM kill/restart growth,
   and no sustained memory ceiling or CPU/probe timeout saturation.
6. Latest-image logs contain no secrets, URLs, SQL or raw error details. Fixed startup stages are
   `queue_connect`, `run_step_consumer`, `maintenance_consumers`, `maintenance_schedules`,
   `prompt_registry`. Missing queue schema and version mismatch are distinct from SQL permission
   and TLS failures. `unknown` means further targeted private diagnosis is still needed.
7. Check web and worker both after a controlled service restart. Do not restart the production
   database just to repeat the local destructive-failure test.

Only after separate **public-exposure approval**, change the service's port 3000 HTTP to public
in `Configure → Networking`. Northflank terminates HTTPS at its edge and supplies a `code.run`
domain/certificate; no Caddy or home tunnel is needed. Keep PostgreSQL private. From outside
Northflank run `node deploy/health.mjs https://<actual-generated-host>` and require valid TLS,
HSTS, no-store and both health endpoints. Verify spoofed forwarding headers cannot bypass
run access or throttling before trusting forwarded addresses. Record the actual public URL
only after success; this task has not created or tested one.

Application initialization uses the existing application flow: the worker registers versioned
prompt templates at startup, and the web UI creates workspace/session state through its normal
cookie/CSRF-protected routes. No seed/reset command or synthetic production sample is needed.
After private readiness succeeds, verify the dashboard and a new empty workspace through the
private access mechanism; leave generation disabled. Do not run local `e2e-db.mjs` on Northflank.

## 6. Backups and rollback

- Keep stable secrets and the existing addon. Record pre-release image digest, variable names,
  resource settings, visibility, backup ID and migration state. Backups contain private data;
  keep them encrypted/restricted and never commit them.
- On application regression, set `RUN_ACCESS=off`, keep/return port private if needed, pause CD,
  select the previously known image/build in Northflank and redeploy the **same service** with
  its matching safe settings. This repair adds no schema migration, so rolling its code back to
  `4706338` does not require dropping tables. Readiness must still be checked; the historical
  main build was unhealthy before migration and is not automatically a known-good fallback.
- A release rollback does not reverse database migrations. Do not run down migrations,
  restore over a live database, drop pg-boss, or delete the addon. For actual database damage,
  stop writers and obtain explicit approval for the provider's restore procedure. Restore to
  an isolated database/clone if the account permits it, validate migrations, roles, data and
  queue safety before switching credentials; that extra resource may need cost approval.
- Local `deploy/smoke.mjs` validates backup/restore with fake data and DML roles. Managed addon
  backup/restore access, quota and a remote recovery drill remain acceptance items, not proven
  by the local Compose result.

## 7. Cost and remaining judge-access gates

Official sources checked 2026-10-25:
[pricing](https://northflank.com/pricing),
[compute plans](https://northflank.com/docs/v1/application/billing/resource-plans-and-quotas),
[public plan API](https://api.northflank.com/v1/plans).
Sandbox advertises $0, no card, two services, two jobs, one database, up to $20/month of resources.
Keep the existing entitlement; actual account usage and eligible sizes must be checked in its UI.
Published monthly compute prices: `nf-compute-20` $5.40, `nf-compute-50` (0.5 CPU / 1 GiB)
$12.00, `nf-compute-100-2` (1 CPU / 2 GiB) $24.00 before tax. These are compute list prices,
not a promise of the total account bill. The public API rounds hourly values (0.008/0.017/0.033);
the pricing page gives finer rates. Storage, DB compute, jobs, egress, backups and tax may add cost.
Do not upgrade based only on the heap defaults: compare actual graphs after fixing queue setup.
If 512 MiB fails private stability/load acceptance, the next plan to evaluate is nf-compute-50;
get approval for any paid change. No upgrade/purchase has been made.

Infrastructure readiness is independent of a verified judge demonstration. Keep `RUN_ACCESS=off`
and all Qloo/LLM caps at zero throughout recovery. Later, only after explicit live-call approval:
configure provider keys in restricted runtime secrets, re-verify current pricing/DeepSeek FX and
its 24-hour price timestamp, issue short-lived limited-use judge grants via the existing admin
CLI, set bounded global/workspace/experiment/grant budgets, and retain `MAX_WORKING_RUNS=1`.
Never enable anonymous paid generation. Production fixtures/scripted output remain forbidden.
Missing Qloo credentials, unverified live quota/permissions and absence of a verified LIVE sample
must be disclosed; an HTTP 200 heartbeat does not verify real Qloo results or a completed experiment.

Additional official operator references:
[secrets](https://northflank.com/docs/v1/application/secure/manage-secret-groups),
[database connections](https://northflank.com/docs/v1/application/databases-and-persistence/access-a-database),
[networking](https://northflank.com/docs/v1/application/network/networking-on-northflank),
[command overrides](https://northflank.com/docs/v1/application/run/override-command-entrypoint),
[release ordering](https://northflank.com/docs/v1/application/release/pipeline/configure-a-release-flow),
[rollback limits](https://northflank.com/docs/v1/application/release/pipeline/run-and-manage-releases).
