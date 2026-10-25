# pg-boss diagnostic release readiness — 2026-10-25

This is a **diagnostic release**, not confirmation that the production incident is fixed.
The user authorized local review, tests and commit only. No push, PR, merge, deployment,
production command, production SQL, credential change or infrastructure change was performed.

## Release identity and diff review

Branch: `codex/northflank-production-repair`. Starting HEAD:
`ae89a0542502f6408752b1f403283f4968e2b75f`. The exact release SHA is included in the final
handoff and can be retrieved with `git log -1 --format=%H -- docs/PG_BOSS_DIAGNOSTIC_RELEASE.md`.
The starting 8 modified / 3 untracked files were the prior incident patch. The entire tracked
diff and all untracked source/tests/docs were reviewed before the release additions.

All changes are limited to diagnostics, regression tests, necessary fail-closed readiness
checks, exports and release documentation. There are no dependency/lockfile, schema migration,
database function, ACL, Dockerfile, paid-provider, application workflow or credential changes.
The existing runtime `migrate:false`, `createSchema:false`, scheduler and 15-second retries remain.

| Changed file | Purpose |
| --- | --- |
| `apps/worker/src/main.ts` | Safe startup/heartbeat diagnostics and capability check before consumer registration |
| `packages/db/src/queue.ts` | Attach actual-pool diagnostics; required function EXECUTE readiness checks |
| `packages/db/src/queue-diagnostics.ts` | Fixed operation/known queue labels; credential-free actual queue pool observations |
| `packages/db/src/diagnostics.ts` | Preserve valid SQLSTATE, allowlisted error fields and retry classification |
| `packages/db/src/diagnose.ts` | Read-only role, TLS, schema-version and capability checks |
| `packages/db/src/diagnose-cli.ts` | Safe CLI startup/query/cleanup handling and nonzero failure exits |
| `packages/db/src/index.ts` | Diagnostic exports |
| `tests/unit/database-diagnostics.test.ts` | Safe output and classified/unclassified SQLSTATE regressions |
| `tests/integration/queue-permissions.test.ts` | Real PostgreSQL DML-only lifecycle, permission failures and recovery |
| `tests/runtime/diagnose.test.ts` | Actual bundled CLI invalid configuration / secret-output regression |
| `deploy/northflank-smoke.mjs` | Execute shipped CLI as UID/GID 10002 under production TLS and read-only DB default |
| `docs/NORTHFLANK_RUNBOOK.md` | Link incident-specific guidance and correct diagnostic coverage |
| `docs/PG_BOSS_STARTUP_INVESTIGATION.md` | Root-cause evidence, ruled-out assumptions, original validation checkpoint |
| `docs/PG_BOSS_DIAGNOSTIC_RELEASE.md` | This reviewed release plan and current validation |

The release review additionally moved pool construction inside the diagnostic CLI's safe error
handler, preserved valid SQLSTATE even when its reason is unknown, and retained only known
application queue names from SQL parameters. Tests cover these additions. No raw SQL, parameter
array, error stack, detail/where field, connection string, password, token, role name or secret
environment value is logged. Unknown identifiers/messages are omitted or redacted. PostgreSQL
permission templates and known internal identifiers remain available for diagnosis.

## Read-only and production packaging verification

`packages/db/package.json` bundles `src/diagnose-cli.ts` as `dist/diagnose.mjs` during the
normal root production build. The unchanged Dockerfile explicitly copies that artifact from
the build stage into `/app/packages/db/dist/diagnose.mjs` in the final runtime image.

The CLI creates a bounded pg pool, never constructs/starts PgBoss, and never calls migrations,
queue creation, job processing or a provider. `inspectRuntimeDatabase` starts `BEGIN READ ONLY`,
issues SELECT/catalog privilege checks, then COMMIT/ROLLBACK. Importing queue constants does
not invoke queue installation. The worker's new identity observations also issue only SELECT;
normal worker queue DML/scheduling continues independently and is not part of the diagnostic CLI.

The enhanced Northflank smoke checks that the file is readable and executes it as UID/GID
10002 with `APP_ENV=production`, the same TLS-verified runtime URL/CA and DML-only database role.
For this local test only, its child connection adds `options=-c default_transaction_read_only=on`.
The app's configuration is not changed. A successful result under this default validates
execution without database writes; source review separately rules out startup/migration calls.
The smoke rejects output containing its URL or long secret environment values.

## Current local verification

| Check | Result |
| --- | --- |
| Full unit suite | 423 passed / 0 failed, 28 files |
| Full PostgreSQL integration suite | 88 passed / 0 failed, 16 files |
| Real schedule-error queue-name assertion | Passed in the final full integration suite above |
| Full standalone runtime suite | 16 passed / 0 failed, 2 files |
| Root/scripts/web/worker type checks | Passed |
| ESLint / Prettier / diff whitespace | Passed |
| Drizzle migration consistency | Passed; no schema change |
| Production web/worker/DB build | Passed locally |
| Browser bundle secret scan | Passed, 672 files |
| Production Docker build | Passed; frozen-lockfile install and full production build |
| Final image container / deployment / Northflank smoke suites | All three passed, exit 0, including cleanup |
| Final bundled Worker and diagnostic EPERM/EPIPE regression | Passed as UID/GID 10002 with network disabled and read-only filesystem; valid/custom SQLSTATE retained |

Final local image: `tessaloom:diagnostic-release`, image ID
`sha256:44485065f1d4d164bb5f4ad1dd81b3c7a3ca7ea3501cfddab4379df1a7eb9d03`,
Linux ARM64, Node 22.23.4. The Northflank simulation passed with 512 MiB / 0.2 CPU,
225.5 MiB peak memory, no paid/provider calls and no public ports. It verified non-root
read-only TLS diagnostics, revoked queue rights returning HTTP 503, grant recovery,
instance-scoped readiness, database restart and graceful shutdown. The deployment suite
also verified HTTPS, secret isolation, backup/restore and PID1 restart with persisted data.
The bundled classifier check evaluates the actual built diagnostic functions in isolation;
the real CLI execution is separately covered by the Northflank smoke. Local ARM64 evidence
does not establish remote AMD64 or managed Northflank behavior.

Host tests use Node 26.11.1. Docker uses the unchanged Node 22 Dockerfile, pinned pnpm
10.34.7 and frozen lockfile. Existing `pg` warnings about concurrent client queries are
deprecation notices, not test failures. Local package scripts were executed using the installed
binaries, avoiding the local pnpm auto-reinstall behavior noted in the original investigation.

Readiness remains fail-closed: failed initialization writes no heartbeat; SQLSTATE 42501
startup retries after 15 seconds without declaring success. Loss of table/function rights
prevents heartbeat renewal, so HTTP readiness becomes 503 within the existing 30-second
freshness window. Tests verify permission restoration, actual job completion and graceful
stop/restart. The readiness endpoint is not bypassed, changed to liveness or forced healthy.

## Exact PR plan — future actions only

1. Obtain explicit publication approval. First confirm that pushing this branch cannot
   auto-deploy production; any required CD change needs production authorization. Fetch the
   latest base/head after approval and check for remote movement. Never force-push or reset
   another author's work. Locally cached `origin/main` is `bf67238`, whose tree equals starting
   HEAD, so the current intended PR delta is only the files listed above; this is not a live
   assertion about GitHub's current state.
2. Push `codex/northflank-production-repair` to `LZH-1-G/tessaloom` only after that approval.
   Open a new draft PR with base `main` and head `codex/northflank-production-repair`.
   The previous PR #16 is already represented as merged in local Git history; do not reopen it.
3. Title: **Add safe pg-boss startup diagnostics and fail-closed capability checks**.
   Proposed body:

   > Production worker startup reports permission_denied at queue_connect without identifying
   > the rejected operation. Add safe SQLSTATE/operation/known-queue diagnostics and actual
   > queue-pool role checks, plus a read-only diagnostic CLI in the existing production image.
   > Check function EXECUTE rights before startup/heartbeat readiness. Preserve runtime DDL
   > restrictions, retries, scheduler and data. Production root cause remains unconfirmed.
   >
   > Validation: 423 unit, 88 PostgreSQL integration and 16 standalone runtime tests; type/lint,
   > production build and local image smoke checks. The image diagnostic is exercised as UID
   > 10002 with TLS, DML-only credentials and a read-only database default. No production calls,
   > schema/ACL change or new environment variables. See PG_BOSS_DIAGNOSTIC_RELEASE.md for the
   > exact image evidence, operational steps and limitations.

4. Require reviewer approval and observe actual PR CI: lint/typecheck/migration consistency,
   unit, integration, security, Docker and browser E2E. CodeQL may be skipped by the existing
   private-repository condition; report that explicitly. Local results do not satisfy remote CI.
   Merge and deployment each require subsequent authorization; do not bundle them into push.

## Runtime configuration and Northflank sequence — not executed

No new environment variable, schema migration or grant is required by this diagnostic patch.
Continue using the existing runtime-role DATABASE_URL with `sslmode=verify-full` (existing
`require`/`verify-ca` are normalized to verification). Keep the correct CA available if the
URL references a certificate file. Use `APP_ENV=production`, `NODE_ENV=production`.
Do not add migrator/admin credentials or disable TLS. The CLI does not need provider keys.
Preserve existing SESSION_SECRET/SHARE_TOKEN_PEPPER and worker/provider configuration.

1. After separate deployment approval, record the current deployment ID, image digest,
   current configuration names, health, backup/recovery state and source build revision.
   Preserve the existing service/database. Keep private access, RUN_ACCESS=off and provider
   budgets zero for this diagnostic stage. Verify actual CD/build-trigger behavior first.
2. Build the reviewed commit for Northflank's actual target architecture using `/Dockerfile`
   and repository root context. Record the resulting immutable image digest and successful
   build. Do not deploy the uncommitted historical image or assume local ARM64 proves AMD64.
3. Deploy that exact approved build to the existing private `tessaloom` service. Keep the
   normal `tini -s --` entrypoint and `node scripts/start.mjs` command; do not replace CMD with
   diagnose.mjs or a migration. Keep the established web/worker UID separation and resource caps.
   This rollout requires no release migration job, role bootstrap or privileged SQL.
4. From the same new instance's private `/app` shell, run the diagnostic and health commands
   below using its already-injected runtime URL. Do not print env or pass credentials as
   command arguments. Record deployment/image identity with the safe JSON output and exit code.
5. Observe at least 10 minutes. If startup still fails, capture one enhanced failure event
   and its connection observation, then stop at evidence gathering. Any SQL repair, provider
   test, restart of production infrastructure, public exposure or resource change needs separate
   authorization. Only if healthy, verify an approved controlled service restart and readiness.

## Exact production commands — prepared, not run

Working directory `/app`, service environment already injected:

```sh
node packages/db/dist/diagnose.mjs
```

Exit 0 means the read-only checks passed; exit 1 reports invalid configuration, missing
capability, incompatible schema, unexpected role or excessive runtime privileges. A nonzero
exit is evidence, not permission to auto-repair. It is independent of the worker's live state.

```sh
node --input-type=module -e 'try { const r = await fetch("http://127.0.0.1:3000/api/health/ready", {signal: AbortSignal.timeout(4500)}); const b = await r.json(); const db = b.db === true; const worker = b.worker === true; console.log(JSON.stringify({status:r.status,db,worker})); process.exitCode = r.status === 200 && db && worker ? 0 : 1; } catch { console.log(JSON.stringify({event:"readiness_probe_failed"})); process.exitCode = 1; }'
```

The HTTP readiness probe must return 503 for a genuine queue startup failure, even if
liveness/container status is passing. Once initialization and current capabilities pass,
require 200 with `db:true,worker:true`. Also require worker_queues_started and no recurring
queue_connect failures. Do not use a healthy old pod's logs/heartbeat as the new pod's proof.

## Expected evidence and interpretation

- `database_diagnostic`: tls=true, elevated=false, schemaCreate/queueSchemaCreate/databaseCreate=false,
  configuredRoleMatches/sessionRoleMatches=true, packageVersion=12.37.0, expectedSchemaVersion=45,
  schemaVersion=45, all required checks true. Values differing from these expectations need review.
- `worker_queue_start_failed`: existing stage/reason/retryMs plus sqlstate, fixed operation,
  known queue when present, sanitized permission/ownership message and known schema/table/routine.
  For the deliberate local negative control: 42501, queue_create, __pgboss__send-it,
  permission denied for function create_queue. This is **not** a prediction of the production cause.
- `connectionVerified:false` means the latest observation failed. Optional startupConnection
  is an earlier observation from the same attempt, not proof that the failed transaction is now
  healthy. Role-match booleans compare against the URL user/session identity; they do not prove
  equality to a separately inspected role whose identity was not provided.
- Unknown error messages/identifiers are deliberately omitted/redacted. A fixed queue_sql
  label or missing optional field is possible; retain the SQLSTATE and startup stage and request
  targeted private inspection, without enabling raw SQL/credential logging.

## Rollback and outstanding risks

On a diagnostic-release regression, redeploy the recorded previous image digest to the same
service using unchanged secrets, runtime role and command. Keep access off/private while
assessing recovery. No down migration, queue deletion, data reset or restore is required.
The previous image may still have the original queue failure; rollback is not incident closure.
Collect the safe evidence before rollback if feasible. Never run destructive schema/role SQL.

Production credentials, installed function bodies, live logs, actual image identity, CI and
Northflank target-architecture execution remain unverified. Local schema version compatibility
does not verify every production function body. The SQL operation/first-query instrumentation
is deliberately pinned to pg-boss 12.37.0 and must be revalidated on a dependency upgrade.
Diagnostic read failures do not replace the original startup error or make the worker ready.
Qloo/LLM readiness remains separate: infrastructure HTTP 200 is not proof of live provider
execution. No paid/external provider request or production command was run in this stage.
