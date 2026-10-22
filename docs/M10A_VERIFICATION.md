# M10-A verification report

> Only checks that actually ran are marked PASS. Deployment-only checks are **BLOCKED** (they need the M10-B hosted environment) or **NOT YET RUN**. Environment: macOS, Node 22.23.3, pnpm 10.34.7, PostgreSQL 16 (local Docker), Playwright 1.64.1, `QLOO_MODE=synthetic`, `LLM_PROVIDER=scripted`. No live Qloo calls and no paid LLM calls.

## Acceptance criteria (M10-A)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| A1 | Site-wide CSP with a per-request nonce; no `unsafe-eval` in production; no wildcard or `unsafe-inline` script sources | PASS (local) | unit `security-headers.test.ts`; runtime `boot.test.ts`; E2E `m10-security.spec.ts` (stored-XSS simulation blocked in Chromium and WebKit); CSP-violation watcher across all journeys |
| A2 | HSTS and `upgrade-insecure-requests` only on HTTPS environments (`staging`/`production`); local HTTP unchanged | PASS (local) | runtime test with `APP_ENV=production` vs `test` against the standalone build |
| A3 | Secure response headers (nosniff, frame DENY, Referrer, Permissions, COOP/CORP; share pages no-referrer/noindex/no-store) | PASS (local) | unit + runtime + E2E |
| A4 | Abuse limits cannot be bypassed (body size, rate-limit eviction, trusted client address) | PASS (local) | `http-security.test.ts`, API integration; default ignores XFF; hosted ingress verification remains required |
| A5 | Production startup validation (TLS database URL, `QLOO_MODE=live`, scripted LLM refused), supervisor log redaction, heap limits, migration lock | PASS (local) | Env/supervisor/redaction unit tests; runtime boot tests; concurrent migration and lock recovery integration; real packaged-supervisor container tests |
| A6 | **Public demo cost safety:** paid LLM generation is off for anonymous visitors by default; revocable demo access; atomic global, per-workspace, and per-experiment spend reservations before provider calls; request, concurrency, token, retry, and job limits; cancel/retry/recovery cannot bypass accounting; read-only demo projects; graceful exhaustion | PASS (local, synthetic only) | Durable ledger, access/retry/sample integration; real invite browser test on both browsers |
| A7 | Cross-module regression Brief → Discovery → Collision → Hypothesis Lab → Evidence Graph → What-if → Blueprint → Revision/Export/Share | PASS (local, final M10-A) | E2E 28/28 on Chromium and WebKit in CI mode |
| A8 | Operational runbook (backup/restore, rollback, monitoring, quota/spend) | PASS (local documentation and restore drill) | `M10A_OPERATIONS.md`, updated deployment checklist, disposable-container dump/restore |
| D1 | HTTPS, HSTS, and Secure cookies observed on the hosted URL | **BLOCKED** (M10-B) | needs hosting |
| D2 | Managed Postgres TLS, roles, release-step migration, restore drill | **BLOCKED** (M10-B) | needs hosting |
| D3 | Live Qloo and Anthropic validation | **BLOCKED** (M10-B, owner authorization) | paid / live |

## Check log

| Checkpoint | Check | Result |
|---|---|---|
| WS1 | `pnpm build` | PASS (`ƒ Proxy (Middleware)` registered) |
| WS1 | `pnpm lint` (ESLint + Prettier), `pnpm typecheck` | PASS |
| WS1 | `pnpm test:unit` | PASS: 280 tests (17 files) |
| WS1 | `pnpm test:runtime` | PASS: 7 tests (includes CSP/HSTS against the standalone server) |
| WS1 | `pnpm exec playwright test` (4 workers, Chromium + WebKit) | PASS: 24/24 (1.7 min) |
| WS1 | `CI=1 pnpm exec playwright test` (2 workers) | PASS: 24/24 (2.5 min), after fixing the dock scroll-region a11y defect (first CI-mode run: 23/24) |
| WS1 | Integration, Docker, container smoke, gitleaks, OSV | NOT RE-RUN at WS1 (no affected code); full run planned at WS4 |

## WS-COST / WS2 checkpoint (2026-10-22)

| Check | Actual result |
|---|---|
| `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm db:check` | PASS |
| `pnpm test:unit` | PASS: 290 tests / 18 files |
| `pnpm test:integration` | PASS: 76 tests / 13 files; isolated local PostgreSQL databases |
| `pnpm test:runtime` | PASS: 7 tests |
| `pnpm exec playwright test` | PASS: 28/28, Chromium and WebKit |
| `INVITE_E2E=1 pnpm exec playwright test` | PASS: 2/2, real invite API and browser, scripted worker |
| `pnpm check:bundle` | PASS: 670 files |
| `pnpm audit --prod --audit-level=high` | PASS: no known vulnerabilities |
| OSV-Scanner v2.3.0, lockfile | PASS: 612 packages, no issues |
| gitleaks v8.30.0, Git history | PASS: 22 commits, no findings |
| gitleaks, snapshot of all tracked + untracked nonignored source | PASS: no findings |
| Broad directory scan including ignored build/browser artifacts | Findings present in ignored artifacts; **not a clean scan**, not used as source-scan PASS. Source/history scans above are separately clean. No allowlist was broadened. |
| `docker build -t tessaloom:m10a .` | PASS, local host architecture |
| `M0_IMAGE=tessaloom:m10a pnpm test:container` | PASS: image migration, real supervised UID/PATH isolation, queue/run roundtrip, heartbeat, worker restart, secret sentinels, shutdown, production fixture rejection |

Initial attempts were not counted as passes: integration setup lacked `DATABASE_URL`; the new browser test first sent unsupported `mode=fixture`, then expected the dashboard access badge in a compact project view that intentionally hides it after redemption. Corrected tests passed against the real server. Two new unit fixtures initially used the wrong scripted-error shape; corrected before PASS. A missing schema export name was corrected before typecheck PASS.

Limitations: no live provider calls, hosted ingress/TLS/restore drill, remote CI or CodeQL; conservative price-based reservations are not a verified provider billing ceiling. Unknown/crashed calls retain allowances, which can exhaust budgets conservatively. The pre-existing pg 8 concurrent-query deprecation remains for WS3 review. E2E explicitly opts into one trusted proxy hop to simulate distinct edge-assigned client addresses; direct runtime default is zero trusted hops.

## Final WS3 / WS4 verification (2026-10-22)

| Check | Actual result |
|---|---|
| Build; ESLint/Prettier; typecheck; migration journal consistency | PASS |
| Unit | PASS: 298 tests / 19 files |
| Full integration | PASS: 78 tests / 14 files; includes 18 cost-safety and 2 migration tests |
| Runtime | PASS: 10 tests; original keyless production shutdown coverage retained with required TLS/live-mode configuration and no provider credentials |
| Full browser regression, `CI=1 pnpm exec playwright test` | PASS: 28/28, Chromium + WebKit, 2.6 minutes |
| Real invite browser suite | PASS: 2/2, Chromium + WebKit |
| Targeted migration + invite checks after local-host test guards | PASS: 2 migration and 2 browser tests |
| Browser bundle | PASS: 670 files |
| Final current-source gitleaks | PASS: all tracked/untracked nonignored source, no findings |
| Final pre-checkpoint Git-history gitleaks | PASS: 23 commits, no findings |
| Dependency audit / OSV | Earlier WS-COST PASS retained: lockfile unchanged; no new dependencies |
| Final Docker build | PASS: Linux arm64 image `sha256:997a304108d3a965a608fb2cefef61425c031c5c6793bb3d0d4ea4ae0fb66d74` |
| Extended Docker smoke | PASS: all previous smoke assertions plus custom-format backup/restore (run state and eight migrations), actual child stdout/stderr redaction through packaged supervisor, database outage readiness 503/liveness 200 and recovery readiness 200 |
| Existing local preview | Restored synthetic/scripted stack at port 3300 against existing migrated `tessaloom_dev`; readiness `{db:true,worker:true}`; no database reset |

The first extended-container log test attempted to reopen a child stdio socket through `/proc` and failed with ENXIO. The replacement test first had nested script quoting wrong; both attempts were failures, not counted as PASS. The corrected test launches a real child with the packaged supervisor's normal UID, allowlist, heap and pipe controls, waits for both streams, and asserts sentinel absence/redaction before succeeding. Typecheck also caught a pg Pool overload type and unsupported pg-boss timeout property; these were corrected to the explicit PoolClient type and PostgreSQL connection options before PASS.

The broad directory scan's 116 redacted findings were all in Git-ignored files (11 build files and 92 browser-artifact files); no source allowlist was widened. This remains separate from clean source/history scans. Generated framework keys and browser sessions must not be committed or published as diagnostics.

No remote CI or CodeQL execution, Linux amd64 build, hosted TLS/ingress, managed PITR, external alert setup, live Qloo or paid Anthropic validation was performed. Production certificate/server identity and actual billing remain hosted/live acceptance gates. The local restore drill does not establish managed-provider RPO/RTO. The pre-existing pg 8 query deprecation remains documented; no driver upgrade was attempted.
