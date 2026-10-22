# M10-B local deployment preparation: verification

Date: 2026-10-22. Repository: `/Users/lzh/Documents/GitHub/tessaloom`. Branch: `codex/m10b-deployment`. Baseline: `96d48c1` (PR #12 merge). This is local preparation, not a public deployment. No hosting purchase/provisioning, live Qloo/paid LLM calls, push or merge commit occurred. The owner explicitly authorized the initial fetch and fast-forward from the stale M9 branch.

## PR #13 Docker push failure: local fix

Inspected on 2026-10-22, starting from a clean working tree at `b7b057fe2c35ff965a2d951ee4e675788cd8b33a`. This follow-up changes only the deployment smoke and its documentation. No application, image, Compose, TLS, supervisor, access-control, dependency or CI workflow configuration changed.

### CI comparison

| Evidence | Failing push | Successful pull request |
|---|---|---|
| Docker job | [119863859403](https://github.com/LZH-1-G/tessaloom/actions/runs/39790184842/job/119863859403) | [119864258695](https://github.com/LZH-1-G/tessaloom/actions/runs/39790298051/job/119864258695) |
| Checkout SHA | `b7b057fe2c35ff965a2d951ee4e675788cd8b33a` | Synthetic merge `004525c70f73672c3a5b27b3d6e70f6f685c673f` |
| Git tree | `8539fecc16d2069012180592ec5e2b2361ecc976` | Identical tree, confirmed through GitHub commit metadata |
| Runner | Ubuntu 24.04, image `20261018.339.1` | Ubuntu 24.04, image `20261012.334.1` |
| Host Node / application platform | v22.23.3 / linux/amd64 | v22.23.3 / linux/amd64 |
| Invocation | `node deploy/smoke.mjs`, `M10B_IMAGE=tessaloom:m0` | Identical |
| Docker build / existing container smoke | Both PASS | Both PASS |
| Deployment step (UTC) | 13:50:49–13:51:43, FAIL | 13:51:53–13:52:56, PASS |
| Last shared successful marker | `proxy_error_log_redaction_passed` at 13:51:42.596 | Same marker at 13:52:50.870 |
| Outcome after that marker | Command failure at 13:51:42.994, under 0.4 seconds later | Recovery and final success at 13:52:55.397 |

Both runs exercised the same full smoke, isolated networks, pinned database/proxy images, verified TLS and zero provider allowances. No push-specific workflow branch exists. Runner image versions differ; the logs do not record exact Docker/Compose versions, so a specific daemon-version regression is not established. The successful runner's published inventory lists Docker 28.0.4 and Compose 2.38.2; the failing runner's linked inventory was unavailable during inspection.

### Root cause and correction

The failing phase is the final process-exit/restart check, immediately after proxy-error redaction verification: the original attached `docker exec ... process.kill(1, 'SIGTERM')` races container shutdown. When PID 1 exits before the signal-sending Node process exits, Docker terminates that exec process as well. The synchronous wrapper treats its nonzero status as a test failure even though the requested shutdown occurred. The original CI failure summary omitted the exit status; attributing it to this race is supported by its location/timing and a local deterministic reproduction with the same empty-stderr command-failure symptom, not a recorded remote exit code.

A disposable `--network none` container reproduced attached sender exit **137** with empty stderr when the sender remained alive after signaling PID 1. Detached signaling on the same container succeeded and automatic restart count advanced again. This separates the Docker exec lifecycle problem from DNS, TLS, provider access, Compose startup and database health, all of which had already passed in the failing run.

The fix uses detached exec for this signal only. The sender deliberately stays alive until Docker terminates it, making the smoke exercise the formerly racy lifecycle on every run. Before signaling, the smoke records the restart count; it then waits for a strictly greater count before accepting verified HTTPS readiness and checking persisted project data. This also closes a second race where the old process could still answer readiness during graceful shutdown. Existing bounded waits remain unchanged; failed signaling, missing restart, failed TLS/readiness and missing data still fail the smoke. There is no catch-and-ignore of exit 137, test skip or security relaxation.

Failure diagnostics now include a fixed phase name and numeric command exit status, and assertion messages pass through the existing redactor. New start/recovery markers report only restart counts. No command arguments, credentials or container environments are added to diagnostics.

### Verification of the fix

| Check | Actual result |
|---|---|
| Isolated Docker lifecycle reproduction | PASS: attached sender returned 137 with empty stderr; detached sender succeeded; automatic restart count reached 2. Disposable container removed. |
| Full `REQUIRE_ARM64=1 M10B_IMAGE=tessaloom:m10b node deploy/smoke.mjs` | PASS, exit **0**; `container_restart_started` count **0**, `container_restart_recovered` count **1**, final `deployment_smoke_passed`. |
| Deployment security regression within that full smoke | PASS: production off/invite denial with zero runs/reservations; open mode rejected; both child UIDs denied mounted secrets; actual web/worker credential boundaries; HTTPS/DB TLS and plaintext rejection; Secure cookies/CSP/HSTS; forged-XFF throttling across workspaces; request size limit; proxy-log redaction; samples; runtime DDL denial. |
| Recovery regression within that full smoke | PASS: migration rerun, backup/restore, database recreation and persistent project, database outage readiness/liveness, proxy recovery, actual app restart and HTTPS recovery. |
| Focused unit tests | PASS: **7 tests / 2 files**, `tests/unit/redaction.test.mjs` and `tests/unit/deployment.test.mjs`. |
| Changed-script ESLint / Prettier / whitespace | PASS. |
| Deployment source secret scan | PASS: gitleaks v8.30.0, no leaks. |
| Cleanup | PASS: no disposable deployment or reproduction containers remain. |

Local runtime: Docker Engine **29.8.1**, Compose **5.5.1**, host Node **26.11.1**. Reused the unchanged ARM64 application image `sha256:947781a053c8e7fa83acaafe202bcc34b6ceb1aa471961c10348fa34179c02ea`; its Node runtime is **22.23.4**. The smoke runs from the checkout, so an image rebuild is unnecessary for this script-only change. This confirms the fix locally on ARM64; the new checkpoint has **not** been pushed or tested by remote AMD64 CI. The prior PR run confirms AMD64 compatibility of the unchanged application baseline, not remote verification of this fix. Unrelated successful suites were not repeated. Cloud prerequisites remain unchanged.

## Resumed security verification

The interrupted working tree contained six modified tracked files, the deployment directory, deployment documentation and a new unit-test file. All were preserved. Docker Desktop was stopped and was restarted locally; the earlier ARM64 image remained available. Previous `/private/tmp` test logs were no longer present, so earlier successful results below are retained from this task's captured execution results rather than falsely described as newly rerun.

The focused command is:

```sh
DEPLOY_SECURITY_ONLY=1 REQUIRE_ARM64=1 M10B_IMAGE=tessaloom:m10b node deploy/smoke.mjs
```

It creates a unique disposable Compose project, verified PostgreSQL TLS, fresh test credentials, an internal HTTPS CA and an internal test client. Both Docker networks remain internal. Provider files contain deliberately invalid sentinels, never live credentials; allowances stay zero. No actual provider authentication/billing is tested. Cleanup removes only that disposable project's containers, volumes, networks and temporary files.

| Required check | Status | Assertion |
|---|---|---|
| Anonymous production invite denial | PASS | Real HTTPS request to create an experiment returns 403 `RUN_ACCESS_REQUIRED`; database has zero agent runs and zero LLM spending reservations. |
| Secret files inaccessible to web | PASS | Under actual web UID 10001, reading each app password, session/pepper and provider mount must fail with EACCES. |
| Worker retains necessary credential access | PASS | Inspect the real supervised worker under UID 10002; both provider environment values must exactly match test sentinels. Session/pepper and migrator URL must be absent. Neither child's environment values are printed. |
| Worker cannot read web-only file mounts | PASS | UID 10002 is also denied direct reads of the mounted secrets; it receives only its allowlisted environment. |
| Web environment excludes providers | PASS | Inspect the real Next process under UID 10001: provider keys and migrator URL absent; session and pepper present. |
| Production deployment rejects open access | PASS | Starting the deployment wrapper with RUN_ACCESS=open fails. |
| ARM64 rebuild containing isolation fix | PASS | `docker build --platform linux/arm64 -t tessaloom:m10b .`; runtime Node v22.23.4. |
| Final source/history secret scans | PASS | gitleaks v8.30.0: all tracked + nonignored untracked source clean; pre-checkpoint history scan clean (24 commits scanned). |
| Changed-file lint / formatting / shell syntax / whitespace | PASS | ESLint, Prettier, bash -n and git diff --check on the affected preparation files. |

Final fixed image: `linux/arm64`, local image ID `sha256:947781a053c8e7fa83acaafe202bcc34b6ceb1aa471961c10348fa34179c02ea`. The resumed orchestration helper runs on host Node v26.11.1; the application, worker, migration and HTTPS test client run with Node v22.23.4 inside the image.

Focused run exited **0** and emitted `secret_file_isolation_passed`, `web_worker_credential_environment_isolation_passed`, `production_invite_denial_passed`, and `deployment_security_checks_passed`. The app's real supervised processes were inspected under their own UIDs; values were compared in-process and not printed. Both child UIDs were denied all five secret-file paths (ten read-denial assertions).

## Defect and remediation

The first resumed secret-file check failed before its success marker: an unprivileged child could read a mounted secret despite the private source files. Environment filtering alone did not secure the shared filesystem. The fix requires the deployment wrapper to run as root, verifies that `/run/secrets` is a directory, makes that container-local parent root-owned and mode 0700, then reads files and starts the existing distinct-UID supervisor. It does not change or relax the supervisor allowlists. The worker's required provider values are still delivered only through its environment; no child needs direct file reads. Public CA certificates are mounted separately.

Other unsuccessful preparation attempts were corrected before their recorded passes: mounted initialization scripts could not execute, so bootstrap now copies the script as non-executable before the official PostgreSQL entrypoint sources it; a complete-bootstrap marker prevents partial initialization passing health checks. Docker Desktop did not provide usable published ports for fully internal test networks, so the test client moved inside that network. API fixtures lacked a required useCase/used an invalid domain hint, and one assertion referenced `runs` instead of `agent_runs`; only the test data/assertions changed. `docker kill` suppressed automatic restart as an operator stop; the recovery test now signals PID 1 from inside the container and checks Docker's restart count. These failures are not counted as passes.

An attempted removal of test network isolation was rejected by automatic approval review and was not executed. The implemented internal-client approach preserves isolation.

## Earlier successful M10-B checks retained

These ran successfully during preparation before the final mounted-secret wrapper fix. The core application, schema, supervisor and existing tests were not modified by that fix. Per the owner's instruction, the full regression suite was not repeated unnecessarily; the final image receives focused security/startup verification above.

| Check | Actual earlier result |
|---|---|
| Full unit suite | PASS: **300 tests / 20 files** (includes two new deployment preparation tests) |
| Full integration suite | PASS: **78 tests / 14 files** |
| Runtime suite | PASS: **10 tests** |
| Chromium/WebKit regression in CI mode | PASS: **28/28** |
| Chromium/WebKit invite suite | PASS: **2/2** |
| Host build, full ESLint/Prettier, typecheck, db:check | PASS |
| Browser secret bundle check | PASS: **670 files** |
| Existing container regression against M10-B ARM64 image | PASS: supervised UID/PATH/credential checks, queue/run roundtrip, worker restart, backup/restore, redaction, readiness outage/recovery, shutdown and production fixture guards |
| Full new deployment smoke | PASS: production off/invite denial; explicit open rejection; HTTPS redirect/certificate verification, Secure cookies/CSP/HSTS; DB verified TLS and plaintext rejection; DML role rejects DDL; eight migrations and rerun; XFF forgery cannot bypass shared-IP throttling across workspaces; oversized body denied; samples available; dump/restore and saved project persistence after DB recreation; outage recovery; proxy failure log redaction; container restart count increments after process exit |
| Resource limits | PASS: actual app cgroup memory and memory+swap limits both 2 GiB; configured PostgreSQL 768 MiB, Caddy 128 MiB |
| Memory observation | Idle snapshot after recovery: app **130.7 MiB**, PostgreSQL **27.6 MiB**, Caddy **17.73 MiB**. Not a concurrency/live-provider load benchmark. |
| Dependency audit | PASS: `pnpm audit --prod --audit-level=high`, no known vulnerabilities; lockfile unchanged |
| Current nonignored source secret scan | PASS: gitleaks v8.30.0, no findings before the final fix; final checkpoint scan recorded below |
| CI workflow syntax | PASS: actionlint 1.7.7; added deployment smoke step. Remote CI was not run. |

## Checkpoint and remaining gates

Local checkpoint: see the commit containing this report (`git log -1 --format=fuller`). Final source/history scan and clean status are checked when creating the checkpoint; do not interpret this document as evidence of remote CI, an AMD64 build, an Oracle tenancy inspection, or a live deployment.

The $0 architecture is technically feasible for a small demo, conditional on actual Oracle free entitlement and capacity. The account must verify home-region A1 capacity, aggregate free compute/storage/backup/traffic/IP allowances, trial expiry behavior, idle-reclamation risk, and a genuinely free encrypted off-host backup destination. Published Oracle limits conflict between the Free Tier guide and price list; use the lower 2 OCPU/12 GB planning assumption until resolved for the account. Hetzner CX23 remains a separately approved paid fallback with AMD64 verification still required. Official pricing links and the manual setup checklist are in [M10B_DEPLOYMENT.md](M10B_DEPLOYMENT.md).

Still unverified: real DNS/ACME renewal; external IPv4/IPv6 firewall and direct-origin denial; host reboot and cloud-volume retention; live workload memory/performance; off-host scheduled backups, certificate rotation, measured RPO/RTO and alert delivery; provider account hard limits/pricing and approved live journeys; remote CI/CodeQL; Linux AMD64. No secrets or infrastructure accounts are requested by this preparation checkpoint. Public deployment, paid provisioning/upgrades, and live provider calls still require explicit owner authorization.


## Changed files in this checkpoint

- Runtime integration: `Dockerfile`.
- Deployment configuration: `deploy/compose.yml`, `deploy/Caddyfile`, `deploy/pg_hba.conf`, `deploy/.env.example`.
- Deployment helpers: `deploy/app-entrypoint.mjs`, `deploy/prepare.mjs`, `deploy/postgres-entrypoint.sh`, `deploy/postgres-init.sh`, `deploy/backup.sh`.
- Verification/CI: `deploy/smoke.mjs`, `tests/unit/deployment.test.mjs`, `.github/workflows/ci.yml`, `package.json`.
- Private artifact exclusions: `.gitignore`, `.dockerignore`.
- Documentation: `docs/M10B_DEPLOYMENT.md`, `docs/M10B_VERIFICATION.md`, `docs/M10_DEPLOYMENT_CHECKLIST.md`.

No M0–M10-A application feature code, schema, existing test assertions, or lockfile changed.
