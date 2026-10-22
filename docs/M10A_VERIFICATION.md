# M10-A verification report

> Only checks that actually ran are marked PASS. Deployment-only checks are **BLOCKED** (they need the M10-B hosted environment) or **NOT YET RUN**. Environment: macOS, Node 22.23.3, pnpm 10.34.7, PostgreSQL 16 (local Docker), Playwright 1.64.1, `QLOO_MODE=synthetic`, `LLM_PROVIDER=scripted`. No live Qloo calls and no paid LLM calls.

## Acceptance criteria (M10-A)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| A1 | Site-wide CSP with a per-request nonce; no `unsafe-eval` in production; no wildcard or `unsafe-inline` script sources | PASS (local) | unit `security-headers.test.ts`; runtime `boot.test.ts`; E2E `m10-security.spec.ts` (stored-XSS simulation blocked in Chromium and WebKit); CSP-violation watcher across all journeys |
| A2 | HSTS and `upgrade-insecure-requests` only on HTTPS environments (`staging`/`production`); local HTTP unchanged | PASS (local) | runtime test with `APP_ENV=production` vs `test` against the standalone build |
| A3 | Secure response headers (nosniff, frame DENY, Referrer, Permissions, COOP/CORP; share pages no-referrer/noindex/no-store) | PASS (local) | unit + runtime + E2E |
| A4 | Abuse limits cannot be bypassed (body size, rate-limit eviction, trusted client address) | NOT YET RUN | WS2 |
| A5 | Production startup validation (TLS database URL, `QLOO_MODE=live`, scripted LLM refused), supervisor log redaction, heap limits, migration lock | NOT YET RUN | WS3 |
| A6 | **Public demo cost safety:** paid LLM generation is off for anonymous visitors by default; revocable demo access; atomic global, per-workspace, and per-experiment spend reservations before provider calls; request, concurrency, token, retry, and job limits; cancel/retry/recovery cannot bypass accounting; read-only demo projects; graceful exhaustion | NOT YET RUN | WS-COST |
| A7 | Cross-module regression Brief → Discovery → Collision → Hypothesis Lab → Evidence Graph → What-if → Blueprint → Revision/Export/Share | PASS (local, WS1 checkpoint) | E2E 24/24 on Chromium and WebKit |
| A8 | Operational runbook (backup/restore, rollback, monitoring, quota/spend) | NOT YET RUN | WS4 |
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
