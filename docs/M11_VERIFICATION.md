# M11 local verification — 2026-10-24

**Local deployment preparation passed. No public deployment, live provider use or submission occurred.** These results do not establish remote firewall behavior, public TLS, cloud capacity, paid invoice ceilings, permitted Qloo replay or hackathon acceptance.

## Baseline and image provenance

Started clean on `codex/m11-public-demo` at `492a6526709b806122dc52b0c9e4141c19f97688`, the PR #14 merge. Read-only `git ls-remote origin refs/heads/main` matched. The GitHub connector could not access this private repository (404); the existing local Git/CLI connection was used instead. PR head `08db9fb` had successful lint/typecheck, unit, integration, E2E, security and Docker checks; CodeQL was skipped because the repository is private. No new workflow was started.

The full `docker build --platform linux/arm64 -t tessaloom:m11 .` stalled on existing build-time Google Fonts downloads with TLS/socket failures and was interrupted (exit 130). A host-only font-host HEAD request succeeded; this does not establish Docker builder connectivity. No font substitution, mock build response, TLS verification bypass or application UI change was used.

The tested image uses `deploy/Dockerfile.runtime`, based on the existing accepted submission image recorded in [prior evidence](submission/verification.json), with only the M11 deployment wrapper overlaid:

| Item                            | Identity                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Accepted base                   | `sha256:d806ce325865ffe673f83aefd12dcfc1c4799f3f63ed8052c22f984a08dbf801`                                        |
| M11 candidate (`tessaloom:m11`) | `sha256:e83f8b9ba942cbe7d70a8349dd5255f1521f565b25f1f2b7d67798ac4c17e926`                                        |
| Platform                        | `linux/arm64`                                                                                                    |
| Layer check                     | All 15 base layers unchanged, exactly one added layer (deployment wrapper)                                       |
| Application baseline check      | No changes from submission commit `160ad0e` to merged main in apps, packages, Dockerfile, supervisor or redactor |

This is a verified runtime update, **not a successful new clean build or AMD64 build**. The root Dockerfile still supports a full build when its external build dependencies are reachable. No image was pushed. Docker Engine was 29.8.1 on the local Mac; actual Oracle/CX23 runtime performance is unmeasured.

## Audit findings and changes

- Existing Compose topology remains Caddy → supervised web/worker → persistent PostgreSQL, with no direct app/DB published ports. DB TLS hostname verification, separate migration/runtime roles, 0700 mounted-secret parent and separate UIDs remain enforced.
- Added an explicitly invoked operator profile. Its entrypoint drops to UID/GID 10001, receives only runtime DB URL and pepper, has no provider mounts/outbound network, and never starts the worker. Unknown wrapper modes fail closed. Real grant CLI create/list/revoke was tested with zero budgets; no judge code was issued for public use.
- Backup helper now accepts explicit env-file/project context. Added a scratch restore helper that rejects existing/production targets, restores as the migrator, retains grants/default privileges and verifies runtime reads. Prior scratch testing restored without ownership and did not prove runtime-role recovery; M11 checks runtime read/write access, DDL denial and revoked-grant preservation.
- Added a bounded read-only HTTPS health probe, independently executed from the Docker client. It requires TLS verification, liveness/readiness semantics, HSTS and no-store and never calls a provider. Bad CA, outage and malformed/redirect/stalled/cached responses fail.
- Added a loopback-only tunnel-origin override with the same production policy. The internal-client POC verifies its actual Caddy route, secure cookies and anonymous denial; no Tailscale/Cloudflare connector was installed or started. Public connector/SSE behavior remains unverified.
- Added hosting decision, exact release/recovery/rollback instructions, safe judge procedure and acceptance blockers. Corrected one earlier deployment checklist line that incorrectly suggested transferring synthetic samples to production. The fixture firewall itself was not changed.
- Cost audit retained transaction-serialized admission and spending reservations, global/workspace/run/experiment/grant limits, cancellation/revocation checks and conservative unknown-charge handling. Production paid work stays off with zero allowances; real Qloo/DeepSeek E2E remains blocked.

## Actual tests

| Command/check                                                                                                                                                | Result                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node node_modules/vitest/vitest.mjs run`                                                                                                                    | **399 passed / 27 files**                                                                                                                                                     |
| Focused deployment, health and redaction unit tests                                                                                                          | **11 passed / 3 files**, included in the 399 total                                                                                                                            |
| `DATABASE_URL=<local-only-test-DB> node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/m10a-cost-safety.test.ts` | **21 passed**; disposable DBs, synthetic/mock providers; includes parallel spend/admission, unknown charges, revocation, DeepSeek policy and production fixture sample denial |
| `REQUIRE_ARM64=1 M10B_IMAGE=tessaloom:m11 node deploy/smoke.mjs`                                                                                             | **PASS**, exit 0; full production deployment smoke on internal networks and fake sentinel keys                                                                                |
| `M0_IMAGE=tessaloom:m11 node scripts/container-smoke.mjs`                                                                                                    | **PASS**, exit 0; existing local synthetic queue journey, actual worker PATH/UID/environment, crash restart, shutdown, fixture/root guards                                    |
| Source ESLint                                                                                                                                                | **PASS**                                                                                                                                                                      |
| Prettier / shell syntax / Node syntax / diff whitespace                                                                                                      | **PASS**                                                                                                                                                                      |

Deployment smoke passed: eight migrations plus rerun; runtime DDL denied; non-TLS DB rejected; mounted files inaccessible to both child UIDs; Qloo/Anthropic/DeepSeek environment only in worker; secure HTTPS/cookies/CSP; off/invite denial with zero runs/reservations; forged forwarding limits; body-size limit; safe operator grant lifecycle; backup nonoverwrite and existing-target restore refusal; runtime restored read/write permissions and DDL denial; persisted project after DB recreation; outage readiness/liveness behavior; redacted proxy failure logs; PID 1 restart count **0 → 1**; and loopback tunnel-origin POC. The probe rejected the internal certificate without an explicitly trusted CA and failed during DB outage.

Worker crash recovery took **1,345 ms** in the existing container smoke. Idle resource snapshot after recovery: app **133.9 MiB**, PostgreSQL **28.07 MiB**, Caddy **18.35 MiB**. These are observations, not live-provider load benchmarks or capacity guarantees. All disposable smoke containers, networks and volumes were removed; unrelated existing services were preserved.

Gitleaks 8.30.0 found no leaks in the nonignored source snapshot (3.68 MB) or pre-checkpoint Git history (30 commits), using network-disabled, read-only containers. Machine-readable results and final scan/checkpoint checks are recorded in [verification.json](evidence/m11/verification.json). Prior browser/CI records remain historical; hosted Chromium/WebKit/SSE acceptance and M11 remote CI were not run. No migrations or application dependencies changed, so unrelated browser journeys and remote dependency audits were not repeated.

## Unresolved release gates

Read [M11 acceptance](M11_ACCEPTANCE.md). Immediate material blockers are account/stock approval, public host/DNS/TLS/firewall acceptance, an approved real-Qloo demo with known quota/expiry/data-use rights, a safe judge policy consistent with rules, and operational off-host backups/monitoring/reboot recovery. DeepSeek's trial limits and 24-hour pricing-review freshness do not establish an unattended live judging service. No fixture exception or unlimited paid access has been added to mask these gaps.
