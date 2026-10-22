# M10-B local deployment preparation: verification

Date: 2026-10-22. Repository: `/Users/lzh/Documents/GitHub/tessaloom`. Branch: `codex/m10b-deployment`. Baseline: `96d48c1` (PR #12 merge). This is local preparation, not a public deployment. No hosting purchase/provisioning, live Qloo/paid LLM calls, push or merge commit occurred. The owner explicitly authorized the initial fetch and fast-forward from the stale M9 branch.

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
