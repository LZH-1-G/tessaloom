# Northflank repair — evidence and acceptance

Independently reverified locally on 2026-10-25 (Beijing). Branch `codex/northflank-production-repair`, based
on remote-confirmed main `47063389ca83090ad85a0ebc9d8592736d28e3aa` (PR #15). Branch push and PR creation are now authorized; their actual status is reported
on GitHub and in the delivery report. No merge, production change, billable provisioning,
public exposure or live provider call occurred.

## Incident and confidence

| Finding                                                                                | Evidence / confidence                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Northflank historically built the image and served Next on port 3000                   | User's October 24 report, not revalidated remotely                                                                                                      |
| Historical readiness was 503, DB true, worker false                                    | Direct service-shell probe in the user's report                                                                                                         |
| Default Docker CMD never runs migrations                                               | Confirmed in `Dockerfile`; only Compose's separate release service invoked the migrator                                                                 |
| Runtime pg-boss cannot create or migrate schema                                        | Confirmed in `packages/db/src/queue.ts`: `migrate:false`, `createSchema:false`                                                                          |
| Unmigrated database causes exactly `Error: pg-boss is not installed` at `boss.start()` | Reproduced against PostgreSQL 16; original log reduced this to `name:Error`                                                                             |
| Explicit migration restores the same waiting worker                                    | Confirmed with actual bundled worker and production container; no app restart/provider key required                                                     |
| Missing privileges / queue version mismatch are separate failures                      | PostgreSQL regression tests reproduce and classify both                                                                                                 |
| Remote schema is missing                                                               | **Leading hypothesis, not confirmed**: no current remote catalog/diagnostic output was accessible                                                       |
| Remote role privileges, queue version, CPU/OOM, actual overrides                       | Unverified; old startup logs cannot establish current values                                                                                            |
| Missing provider keys explain queue installation failure                               | Ruled out in source and keyless local startup; provider functionality remains unavailable                                                               |
| `sslmode=require` warning explains reported worker error                               | Not established. Historical db=true proves at least one DB path connected. Repair pins existing certificate/hostname verification without disabling TLS |
| 512 MiB necessarily cannot run web + worker                                            | Not supported: measured private keyless smoke passed at 0.2 CPU / 512 MiB. Real provider workload not measured                                          |

The initial generic supervisor configuration error could have several causes. The reported
correction enabled web/worker startup, but no historic error field can now be recovered from
`invalid_configuration` alone. New supervisor logs report only the validated field name.
The tini warning is addressed with subreaper mode; it is not identified as the queue failure cause.

## Independent review finding and negative control

The initial repair still wrote heartbeats after a running worker lost queue UPDATE privileges.
A disposable production container using the old image returned **200 `{db:true,worker:true}`**
35 seconds after revoking UPDATE on `pgboss.job`; the new negative test failed at
`queue_privilege_loss`. This is a confirmed local defect, not a claim about the original remote incident.

Before each heartbeat, `assertQueueReady` now performs one read-only query to validate the
installed queue schema version against the pinned library, all three queue definitions, and
runtime queue table privileges. Failure stops heartbeat renewal and logs a fixed reason.
The existing 30-second heartbeat freshness window remains; no health result is forced green.
On the final image the same revocation returned **503 `{db:true,worker:false}`**, and restoring
privileges recovered 200 without a process restart. The container smoke also repeats the
other-instance heartbeat, DB restart and shutdown checks. Integration tests cover missing
queue definitions/version drift, concurrent migration serialization and preservation of an
existing data row across repeated migrations.

## Implemented changes

- Safe fixed-vocabulary DB error classifier and exact queue startup stage; no raw message, SQL,
  connection string, credential or arbitrary driver code is emitted. Includes missing schema,
  version mismatch, permission, network, TLS, authentication and timeout classes.
- Read-only `packages/db/dist/diagnose.mjs` in the production image: TLS, elevated role,
  DDL capability, application/queue table and DML checks and required queue presence.
- Shared URL normalization preserves pg 8 certificate + hostname validation for `require` and
  `verify-ca`; explicit verify-full is used at DB pools, pg-boss, migration and readiness.
  Existing production validation still rejects conflicting TLS options.
- Queue connection timeout 5 s, statement timeout 15 s; existing retries remain 15 s. No
  runtime DDL is introduced. Shutdown cancels retries and waits for in-flight startup before
  closing resources; late startup cannot publish a ready heartbeat after stop begins.
- Queue startup no longer waits for local Qloo harness diagnostics. They remain offline.
- Per-supervisor UUID for colocated worker/web readiness, replacing ambiguous PID-only identity.
  An old pod's fresh heartbeat cannot make the new pod ready. Shared-role deployments remain supported.
- `tini -s --`, explicit 128/192 MiB web/worker heap profile, one-run admission and zero budgets
  in `deploy/northflank.env.example`. Generic Compose resource defaults remain unchanged.
- Reviewed empty-database role bootstrap, separate migration-job ordering, restricted secret groups,
  recovery, HTTPS exposure and rollback instructions in `NORTHFLANK_RUNBOOK.md`.
- CI builds the real worker before integration tests and includes the new private resource smoke.
  The PR reports the actual remote CI status; local results do not substitute for it.

Initial repair checkpoint: `6694217b70227a56d9c93056b6e2129ced74aa1c`.

## Actual local results

| Check                                                               | Result                                                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| ESLint, Prettier, git diff whitespace                               | Passed                                                                                                      |
| Root TS, scripts checkJs, web TS, worker TS                         | Passed                                                                                                      |
| Unit/security tests                                                 | 28 files, **414 passed**                                                                                    |
| PostgreSQL integration, final rebuilt worker                        | 15 files, **85 passed**                                                                                     |
| Runtime standalone processes, final rebuilt worker                  | **12 passed**                                                                                               |
| New PostgreSQL incident regressions                                 | 3 included in the 85 above                                                                                  |
| Eight application migrations, queue installation, repeat migrations | Passed                                                                                                      |
| DML-only role consumes/schedules jobs, forbidden DDL denied         | Passed                                                                                                      |
| Full production Docker build from source                            | Passed; initial intermediate type error corrected before successful build                                   |
| Existing production container smoke                                 | Passed; worker restart 1223 ms, shutdown, root identity, fixture guard, credential isolation                |
| Existing production Compose deployment smoke                        | Passed; TLS, HTTPS, invite denial, secrets, grants, backups, restore permissions, PID1 restart, persistence |
| Northflank-like default CMD, 512 MiB, 0.2 CPU, private TLS DB       | Passed; 503 before migration → 200 DB+worker after migration                                                |
| Startup plus two release migration executions                       | **20,549 ms** in the resource smoke                                                                         |
| Memory peak from Linux cgroup `memory.peak`                         | **228.2 MiB** under the 512 MiB hard/no-swap limit                                                          |
| Small HTTP load                                                     | 12 GETs, three concurrent at a time: home, liveness, readiness                                              |
| Stopped worker + fresh other-pod heartbeat                          | Correct 503 after freshness window, then 200 after worker resumes                                           |
| DB restart and graceful application stop                            | Recovered; migrations retained; exit 0, OOMKilled false                                                     |
| Frontend bundle secret-sentinel check                               | Passed, 672 files                                                                                           |
| Database schema drift check                                         | Passed                                                                                                      |
| Gitleaks candidate source and committed history                     | Passed, no findings; generated framework caches are excluded release inputs                                 |

Local host tests used Node 26.11.1. The actual production image and container smokes used
Node **22.23.4** on Linux ARM64. `.nvmrc` remains 22.23.3. Fresh Chromium and WebKit
E2E passed 28 workflow/security tests plus 2 invite tests, with APP_ENV=test and visibly
labeled synthetic/scripted providers. No live-provider suite was run. The actual Northflank
instance remains untested; remote CI is reported separately. These limits are not production acceptance.

Image: `tessaloom:northflank-verified` (local only), image ID
`sha256:6422df8842b113ac4aff58ebb2ea858abb70bd54200c61f647d80d24a91cb539`.
The full build, not the M11 wrapper-only Dockerfile, produced this image. All temporary smoke
containers, networks and volumes were removed; existing unrelated containers were untouched.

The initial whole-directory scanner included ignored `.next` caches/manifests and flagged
26 generated-file findings plus one documentation false positive (a compute plan identifier
following the words “plan API”). The prose was reworded without weakening scanner rules.
Candidate-source scanning excludes ignored outputs, matching Git/Docker release input; the
Docker build did not copy host `.next` caches. Do not publish local cache artifacts.

## Exact fresh verification commands

Run from the repository root. Local DATABASE_URL/E2E_DATABASE_URL values are injected privately
and point only to isolated local test databases; never use a production URI. The host's pnpm 11
otherwise tries to replace the existing modules tree before running a script, so only that
host-side automatic reinstall is disabled. Docker/CI still use the pinned package manager and
frozen lockfile. No dependency validation or security assertion is disabled.

```sh
export pnpm_config_verify_deps_before_run=false
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm run test:integration
pnpm run test:runtime
pnpm run test:e2e
INVITE_E2E=1 pnpm run test:e2e --output=test-results/northflank-invite
pnpm run db:check
pnpm run check:bundle
pnpm audit --prod --audit-level=high
docker build --progress=plain -t tessaloom:northflank-verified .
M0_IMAGE=tessaloom:northflank-verified pnpm run test:container
M10B_IMAGE=tessaloom:northflank-verified pnpm run test:deployment
NF_IMAGE=tessaloom:northflank-verified node deploy/northflank-smoke.mjs
```

Two browser test databases with the `tessaloom_e2e_nf_verify` prefix were created for this run
and removed afterward. Gitleaks v8.30.0 scans the candidate source and final Git history with
`--redact --config .gitleaks.toml`; it runs without network and with a read-only repository mount.
No live test suite or real API call was attempted. Expected failures are retained explicitly:
old-image permission-loss negative control fails; final-image regression passes. The previous
session's intermediate Docker type-check failure was corrected; the fresh full build passed.
PostgreSQL tests emit a pg 9 forward-compatibility concurrent-query deprecation warning;
this is separate from the fixed TLS mode warning and did not cause a test failure.

## Production acceptance checklist — pending until observed on Northflank

- [ ] Latest image/commit and instance recorded; distinguish old rollout logs.
- [ ] Read-only diagnosis confirms actual schema/queue failure; unsupported hypotheses removed.
- [ ] Existing addon backup recorded and managed recovery permissions/cost understood.
- [ ] Runtime URL uses DML-only role with TLS; administrator/migrator groups excluded from service.
- [ ] Explicit release job on same image exits 0 before application deployment.
- [ ] Secrets supplied only in restricted runtime groups; no provider secrets in web.
- [ ] `RUN_ACCESS=off`, all spend/Qloo caps zero, production live mode retained.
- [ ] Latest web and worker remain running without crash/OOM loops.
- [ ] Direct readiness 200 `{db:true,worker:true}` and Northflank 1/1 stable for at least 10 min.
- [ ] Memory/CPU and probe latency pass private account-specific acceptance; no upgrade without approval.
- [ ] Approved public port exposes managed HTTPS; independent external health check passes.
- [ ] Proxy trust/header behavior validated; anonymous paid runs remain denied.
- [ ] Approved bounded live Qloo + DeepSeek workflow produces truthful evidence and usable judge access.
- [ ] Live Qloo usage/display/retention permissions verified; no fixture or scripted production samples.
- [ ] Judge grant expiry/use/spend caps and global kill switch reviewed.
- [ ] Public repository/submission/video and deadline requirements completed separately with approval.

Highest-priority next action: run the runbook's read-only catalog diagnostic on the **latest
existing Northflank instance**. That result determines whether to execute migrations, repair
specific grants, or investigate another classified failure. The current remote root cause
and remote recovery cannot honestly be certified from local evidence alone.
