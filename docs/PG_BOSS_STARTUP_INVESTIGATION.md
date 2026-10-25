# pg-boss startup permission investigation — 2026-10-25

## Conclusion and scope

The supplied production conditions do **not** reproduce the failure locally. This patch is
ready for diagnostic rollout after review; it is **not a verified production incident fix**.
No production connection, privileged SQL, credential change, push, PR, merge or deployment
was performed. No schema/ACL patch is justified by the evidence currently available.

Initial checkout: `codex/northflank-production-repair`, HEAD
`ae89a0542502f6408752b1f403283f4968e2b75f`, clean (0 modified/untracked files).
The supplied deployed revision `bf67238` is a merge containing this HEAD. Both have the
identical tree `5dea95669dd251e8b3febd857a043300917d646e`; there is no source diff between them.
The remote deployment/image and its actual credentials were not accessed in this investigation.
No applicable AGENTS.md was found. Existing source, migrations, deployment, readiness,
supervisor, tests and handoff/runbook files were inspected before edits.

## Evidence and execution path

`scripts/start.mjs` passes the same allowed `DATABASE_URL` to worker and web. Worker parses
that URL, creates an application pool and a separate pg-boss pool using the same value.
`verifiedDatabaseUrl` pins production TLS verification. No migrator URL enters this path.
Actual production URL/role equality with the earlier SQL investigation remains unconfirmed.

`apps/worker/src/main.ts` → `createBoss` → `boss.start()` → pg-boss contractor check → manager
queue cache → supervisor/flow timers → timekeeper → `createQueue('__pgboss__send-it')` → internal
consumer → instance registration. Application consumers, schedules and prompt registration
follow. `worker_queue_start_failed.stage=queue_connect` covers **all of boss.start()**, not
only opening a socket, and therefore cannot identify the rejected statement by itself.

Pinned manifest, lockfile and installed package all agree: **pg-boss 12.37.0, schema 45**.
The supplied production schema number 45 is compatible with that package; it does not prove
the deployed binary uses this package or that database function bodies match the installation.
The new worker diagnostics report its bundled version and expected schema version.

Verified against the installed package's `dist/index.js`, `contractor.js`, `timekeeper.js`,
`manager.js` and `plans.js`:

| Hypothesis | Evidence / disposition |
| --- | --- |
| Runtime automatically migrates/creates schema | Already `migrate:false`, `createSchema:false`. Contractor checks exact schema version; rejects both older and newer versions. No configuration toggle was needed. |
| It calls createQueue on an existing queue | Yes: timekeeper always calls the internal scheduler queue. Three application queues are provisioned by the existing release migrator, not by worker. |
| Existing create_queue performs DDL | No in this installed schema: INSERT ON CONFLICT then RETURN when no row inserted. A newly inserted nonpartitioned queue also returns before DDL. Confirmed with a DML-only role. |
| Missing queue always needs CREATE | No for nonpartitioned shared queues, including internal scheduler queue. Application queues are still required and fail closed when absent. |
| Index/partition operations require ownership | Yes for a **new partitioned** queue; the local negative test denies this. No evidence of that path for the supplied four nonpartitioned queues. |
| Missing function EXECUTE could produce the reported loop | Reproduced after deliberately revoking create_queue EXECUTE. This is a diagnostic negative control, **not the production root cause**, since the supplied inspection reports EXECUTE=true. |
| Wrong runtime role | Possible but not established. New observations query current_user/session_user through the actual pg-boss adapter, comparing to the URL user without printing identities. |
| Database grants alone prove end-to-end readiness | No. Actual consumer processing, retry, shutdown/restart and readiness transitions are tested separately. |

The `create_queue` batch also uses a transaction, local timeout settings, an advisory lock
and `sha224`; the read-only diagnostic now checks the two relevant built-in EXECUTE rights.
Generic upstream option semantics are documented in the [official constructor documentation](https://pgboss.io/api/constructor);
the version-specific conclusions above come from the installed code and PostgreSQL tests.

## Implemented changes

- `packages/db/src/queue-diagnostics.ts`: annotate rejected actual pg-boss SQL calls with
  fixed operation labels, preserving the original error. No query text/parameters are emitted.
  Identify the known internal scheduler queue. Observe role-match/CREATE booleans through
  pg-boss's own pool before its first startup query and on success/failure. If a failed batch
  leaves a transaction aborted, `connectionVerified:false` may include the separately labelled
  `startupConnection` observation from that same startup attempt. Pool connection failure
  remains unverified; diagnostics never replace the original failure.
- `packages/db/src/diagnostics.ts`: retain existing reason strings; add SQLSTATE, allowlisted
  schema/table/routine and permission/ownership message templates. Unknown object names are
  redacted, arbitrary messages/detail/where/query/stack are omitted. Retry classifications
  distinguish operator action from transient failures; actual retry interval stays 15 seconds.
- `packages/db/src/queue.ts`: attach diagnostics; check required function EXECUTE privileges
  alongside table DML, schema version and application queues before renewing heartbeat.
- `apps/worker/src/main.ts`: add `queue_capabilities` stage before application registration,
  safe `worker_queue_connection` event and diagnostic fields on existing failure events.
  Existing event/reason/stage/retryMs fields remain intact; heartbeat errors remain deduplicated.
- `packages/db/src/diagnose.ts` and `diagnose-cli.ts`: read-only schema-version compatibility,
  relevant function privileges, database/schema CREATE and role-match checks. Exit nonzero
  for incompatible/missing capabilities, unexpected role or runtime DDL capability.
- `packages/db/src/index.ts`: export diagnostics.
- `tests/unit/database-diagnostics.test.ts`: redaction/cause/classification regressions.
- `tests/integration/queue-permissions.test.ts`: actual admin-owned PostgreSQL schema with a
  distinct DML-only runtime role; processing, scheduler, missing queues, partition denial,
  older/newer schema rejection, diagnostic failures, real worker retry/readiness and shutdown.

No dependency, lockfile, schema, function definition, runtime credential or permission change.
No SECURITY DEFINER and no disabled scheduler/readiness/error suppression.

## Privilege contract and readiness

The tested runtime contract is CONNECT to the application database; USAGE on public/pgboss;
SELECT/INSERT/UPDATE/DELETE on existing application and queue tables; USAGE/SELECT on application
sequences where used; EXECUTE on pgboss.create_queue(text,jsonb), pgboss.job_now() and ordinary
PostgreSQL built-ins (notably pg_advisory_xact_lock(bigint), sha224(bytea)). The tested pg-boss
schema has no standalone sequence. Blanket ownership, CREATE, TRUNCATE, SUPERUSER or membership
in the migration role are unnecessary. The normal library maintenance was also executed as
the runtime role. This is the supported tested contract, not an exhaustive minimal ACL proof
for every unused pg-boss feature.

Keep schema installation/upgrades and any new partitioned queues in the existing explicit
release migrator under the actual schema/object owner. Do not run empty-database role bootstrap
against this populated production database. Do not change the create_queue function or grant
CREATE simply because its body contains conditional DDL.

HTTP readiness remains DB connectivity plus a fresh matching worker heartbeat, with a
30-second expiry. Heartbeats require queue startup/capability checks; an old pod cannot
substitute for the supervisor's current heartbeat ID. Function-right loss now stops heartbeat
renewal as table-right loss already did. This bounded freshness window is unchanged.
Qloo readiness remains separately recorded; an infrastructure HTTP 200 does **not** assert
Qloo credentials/network/LLM readiness. No live provider calls were made. Full provider
acceptance remains unverified without authorized external dependencies.

## Safe Northflank next steps (operator actions, not executed)

1. Review this local diff and authorize publication/deployment separately. Record current
   image digest, deployment ID, configuration names and existing backup/recovery state.
   Keep `RUN_ACCESS=off` and provider budgets zero while diagnosing. Preserve existing secrets.
2. Build/publish the reviewed code through the existing controlled release process. Deploy
   that exact image to the private service after explicit approval. **No new environment
   variables, administrator migration or runtime grants are required by this patch.**
3. In the new image's private `/app` service shell run the read-only diagnostic:

   ```sh
   node packages/db/dist/diagnose.mjs
   node -e "fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(4500)}).then(async r=>console.log(r.status,await r.text())).catch(()=>{console.log('probe_failed');process.exitCode=1})"
   ```

   Capture one `worker_queue_start_failed` event and its safe connection observation from
   the **same deployment instance** if failure persists. This is the smallest next observation
   needed; it should identify the operation/object/SQLSTATE instead of another broad grant attempt.
   `configuredRoleMatches=true` proves agreement with the worker URL user, not agreement with
   an independently inspected role whose name was never supplied to this investigation.
4. If diagnostics show an actual missing grant, the existing owner/admin should apply only
   that identified grant to the confirmed runtime role, then let the worker retry. If schema
   mismatch or altered function bodies are found, review the exact owner migration first,
   back up, and run the same-image release migrator before worker rollout. Do not grant DDL
   to runtime, recreate queues/jobs, or automatically modify production.
5. Require worker_queues_started, compatible schema/required checks, matching role observations,
   HTTP 200 after startup, and no repeated queue_connect failures for at least 10 minutes.
   Verify restart recovery. Separately verify Qloo readiness with authorized valid dependencies
   and a bounded application run when provider execution is authorized.
6. Rollback is code-only: redeploy the recorded previous image with unchanged secrets/settings.
   No down migration or database restore is required for this patch. That image may still have
   the original startup failure; rollback is not proof of recovery. Preserve all data and use
   the existing backup procedure only if a separately approved database repair requires it.

## Local validation

| Check | Observed result |
| --- | --- |
| Full unit suite | 28 files, 419 passed, 0 failed |
| Full disposable PostgreSQL integration suite | 16 files, 88 passed, 0 failed |
| Final focused permissions regression after rebuilding worker | 3 passed, 0 failed (included in the 88 unique tests above) |
| Standalone runtime processes | 12 passed, 0 failed |
| Root/scripts/web/worker type checking | Passed |
| ESLint, Prettier, diff whitespace | Passed |
| Web, worker, migration/admin/diagnostic builds | Passed |
| Browser bundle secret check | Passed, 672 files |
| Final production Docker image build | Passed, Node 22 image, frozen lockfile |
| Production container smoke | Passed: real queue roundtrip, worker restart (1,344 ms), DB outage recovery, graceful stop, isolation/redaction |
| Full Compose deployment smoke | Passed: TLS/HTTPS, secrets, DML roles, backup/restore, PID1 restart and persisted data |
| Northflank-like private deployment smoke | Passed: TLS + separate roles, missing schema 503 → release migration → 200, queue UPDATE revoke → 503 → grant recovery, instance-scoped readiness, DB restart, graceful shutdown |

Final local image: `tessaloom:queue-diagnostics`, image ID
`sha256:6c2b7f83a37554140c35cdcfba44be30b0bcca33bf937b72c7b07d009324defb`,
Linux ARM64, Node 22.23.4. The Northflank-like test used 512 MiB / 0.2 CPU and measured
217.8 MiB peak cgroup memory; paid/Qloo calls and public ports were both zero. This is local
ARM64 evidence, not a managed Northflank or remote AMD64 acceptance result. All disposable
test resources were removed; the final local image is retained for review.

Host test runtime was Node 26.11.1; container validation uses the repository's Node 22 image.
An initial sandboxed unit run could not bind loopback (EPERM); the authorized rerun passed
all tests. Local pnpm attempted an automatic dependency reinstall and aborted without a TTY;
existing local binaries ran the package build/test commands instead. The image's pinned pnpm
10.34.7 completed the normal frozen-lockfile install and full build. No tests were disabled.
No browser E2E, remote CI, live Qloo/LLM or production acceptance was claimed by this task.

The initial investigation ended on `codex/northflank-production-repair`, HEAD `ae89a05`,
with 8 modified tracked files and 3 new files left uncommitted. Those figures/results above
describe that checkpoint. The subsequent reviewed local diagnostic release and current
validation are recorded in [PG_BOSS_DIAGNOSTIC_RELEASE.md](PG_BOSS_DIAGNOSTIC_RELEASE.md).
No existing user changes were overwritten and no branch/history was reset.
