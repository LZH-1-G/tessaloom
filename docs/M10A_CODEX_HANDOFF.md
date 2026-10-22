# M10-A Codex handoff

> Living document. It is updated at every checkpoint so OpenAI Codex (or another agent) can resume M10-A without redoing work. **Only record work that actually happened.** The verification report for M10-A is [M10A_VERIFICATION.md](M10A_VERIFICATION.md).

## 1. Branch and commit

- Branch: `claude/m10-production`, created from `main` at `a114ddd` (PR #11, M9 merged). `main` = `origin/main` = `a114ddd` at the start.
- Latest local M10-A commit: see `git log --oneline main..claude/m10-production` (each checkpoint is listed in §2).
- Nothing has been pushed. No PR exists.

## 2. Completed M10-A tasks (checkpoint commits)

| # | Workstream | Commit | Verified by |
|---|---|---|---|
| — | Repository verification: M9 (`ad7b302`) is in `origin/main`; local `main` fast-forwarded (already equal); branch created | — | `git merge-base --is-ancestor` |
| 1 | WS1 security headers: `apps/web/src/proxy.ts` + `apps/web/src/server/security-headers.ts` (per-request CSP nonce, HSTS on staging/production only, nosniff, DENY framing, Referrer/Permissions/COOP/CORP, share-page policy); root layout dynamic; `next.config` share headers moved to the proxy. E2E: CSP-violation watcher in `e2e/helpers.ts`, per-test client address (`X-Forwarded-For`, TEST-NET-3), new `e2e/m10-security.spec.ts` (headers, nonce rotation, XSS markup as text, stored-XSS simulation blocked). Fixed: the dock timeline scroll region was not keyboard-focusable (axe, intermittent in WebKit) | see `git log` (message `feat(m10a): site-wide CSP …`) | unit 280, runtime 7, E2E 24/24 (4 workers) and 24/24 (CI=1) |

## 3. Work in progress

- WS-COST and WS2 completed locally on 2026-10-22; checkpoint message `feat(m10a): guard demo access and spending across every attempt`. Next: WS3 runtime/supervisor and WS4 operations.

## 4. Remaining tasks (priority order)

0. **WS-COST (completed locally): Public Demo Cost Safety (owner requirement; part of the M10-A acceptance criteria).** Server-side and fail-closed:
   - Paid LLM generation is **disabled for anonymous visitors by default**.
   - Restricted, revocable demo access for authorized testers and judges.
   - Atomic **global, per-workspace, and per-experiment** spending reservations before every provider call.
   - Request, concurrency, token, retry, and job-creation limits.
   - Cancelled, retried, and recovered jobs cannot bypass accounting.
   - Saved demo projects are read-only and never invoke the LLM.
   - Honest fixture/live labels; provider keys never reach browsers.
   - Budget exhaustion stops new paid work gracefully while the rest of the site keeps working.
   - Tests for parallel requests, repeated retries, anonymous requests, and budget exhaustion.
   - No live paid calls, no provider activation, no deployment.
1. ~~**WS1 Security headers**~~ (done, see §2):
   - Add `apps/web/src/proxy.ts`, a Next 16 Proxy running on the Node runtime by default:
     - a per-request nonce;
     - CSP `script-src 'self' 'nonce-…' 'strict-dynamic'`, plus `'unsafe-eval'` only when `NODE_ENV=development`;
     - `style-src 'self' 'unsafe-inline'` (React style attributes need it; adding a nonce would disable `'unsafe-inline'`);
     - `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`;
     - `upgrade-insecure-requests` and HSTS only when `APP_ENV` is `staging` or `production`;
     - `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP;
     - API responses get `default-src 'none'; frame-ancestors 'none'`.
   - Make the root layout dynamic (`await connection()`) so nonces apply.
   - Tests: unit (header builder), runtime (standalone server with `APP_ENV=production` and `test`), E2E (headers on every page, no CSP console violations).
2. **WS2 Abuse hardening (completed locally) (`apps/web/src/server/http.ts`):**
   - Enforce the 64 KB body limit while streaming (check `Content-Length` first).
   - Bound the limiter at 10k keys; prune expired buckets and refuse new keys at capacity. Active limits are never evicted by attacker-controlled key churn.
   - Use `TRUSTED_PROXY_HOPS` from the right of `X-Forwarded-For`. Default **0** ignores untrusted headers; explicit 1 requires an ingress that overwrites/appends the client address and blocks direct origin access. CSRF compares Origin to Host, never a client-supplied forwarded host.
3. **WS3 Runtime and supervisor:**
   - Pipe child stdout/stderr through a line redactor that removes secret env values, URL credentials, and `Bearer` / `sk-ant-` patterns.
   - Per-child heap limits (`TL_WEB_MAX_OLD_SPACE_MB`, `TL_WORKER_MAX_OLD_SPACE_MB`).
   - The supervisor rejects `LLM_PROVIDER=scripted` in production.
   - Production and staging require a TLS `DATABASE_URL` (`sslmode=require|verify-ca|verify-full`).
   - Production requires `QLOO_MODE=live`.
   - Migrations take a `pg_advisory_lock` and use a longer statement timeout.
4. **WS4 Operations:**
   - A runbook: backup/restore, rollback, monitoring, quota and spend guards, incident response.
   - Update `M10_DEPLOYMENT_CHECKLIST.md`.
   - Run the full regression (all suites, E2E on both browsers, Docker + container smoke, gitleaks, OSV).
   - Write the verification report.

## 5. Files created or modified

- `docs/M10A_CODEX_HANDOFF.md` (this file), `docs/M10A_VERIFICATION.md`.
- WS1: `apps/web/src/proxy.ts` (new), `apps/web/src/server/security-headers.ts` (new), `apps/web/src/app/layout.tsx`, `apps/web/next.config.mjs`, `apps/web/src/components/activity-dock.tsx`, `e2e/helpers.ts`, every `e2e/*.spec.ts` (imports `test`/`expect` from `./helpers`), `e2e/m10-security.spec.ts` (new), `tests/unit/security-headers.test.ts` (new), `tests/runtime/boot.test.ts`.

## 6. Architecture and security decisions (M10-A)

- Keep ADR-017: a single service, with a supervisor running the web and worker children. Do not split services in M10-A.
- Security headers live in the Next Proxy, not in `next.config` `headers()`. `headers()` is resolved at build time, while HSTS and `upgrade-insecure-requests` depend on the runtime `APP_ENV`. The image is built once and configured per environment.
- Local HTTP testing stays compatible:
  - `APP_ENV=development|test` gets no HSTS, no `upgrade-insecure-requests`, and no `Secure` cookies (SECURITY §4.1, unchanged);
  - CSP still applies, so the E2E suite exercises it.

## 7. Commands executed

```bash
git status --short; git branch --show-current; git log --oneline -3
git fetch origin
git merge-base --is-ancestor ad7b302 origin/main     # → true
git fetch . origin/main:main                          # main already == origin/main (a114ddd)
pnpm build && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:runtime
pnpm exec playwright test            # 4 workers, Chromium + WebKit
CI=1 pnpm exec playwright test       # 2 workers
```

Environment for all checks:

```bash
export PATH=/private/tmp/tessaloom-m0-tools/node_modules/node/bin:/private/tmp/tessaloom-m0-tools/node_modules/.bin:$PATH
export DATABASE_URL=postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom   # integration tests
```

## 8. Test status

See [M10A_VERIFICATION.md](M10A_VERIFICATION.md).

## 9. Known defects and unresolved risks

- The E2E suite gives each test its own `X-Forwarded-For` client address. Without it, all browsers share one per-IP bucket and the unchanged 20/min workspace-creation limit refuses the suite's own bursts (seen once in WS1). The limits themselves are unchanged and are integration-tested.

- `pg` deprecation warning about concurrent `client.query()` (M8 `Promise.all` inside transactions). It is harmless on pg 8 and must be fixed before pg 9.
- Optional blueprint gap-fill queries, ad hoc resolution, and REVALIDATION are not implemented (ADR-027, ADR-028).

## 10. Next implementation step

WS3: supervisor log redaction and heap limits; production TLS/provider validation; serialized migrations. Then WS4 operations and final regression.

## 11. Restrictions (must be respected by any agent)

- Never request, print, or commit credentials. `QLOO_API_KEY` and `ANTHROPIC_API_KEY` are worker-only and never placed in the repo, the web env, or logs.
- No paid Anthropic calls. No live Qloo calls without the owner's explicit authorization. Automated tests use `QLOO_MODE=synthetic` and `LLM_PROVIDER=scripted`.
- No hosting purchase, deployment, publication, or repository visibility change. M10-B covers hosting.
- No push, merge, force-push, history rewrite, or PR without the owner's authorization. Make local commits only, and end each with the `Co-Authored-By` line used in this repository.
- Do not migrate or modify any live external database. Local Postgres only (`tessaloom-postgres-1`; databases `tessaloom`, `tessaloom_dev`, `tessaloom_e2e`).
- Keep the `tessaloom-dev-stack` preview (port 3300) usable.
- Do not start M11.

## WS-COST checkpoint details (2026-10-22)

Preserved and completed the 31 modified and 10 untracked Claude files present at handoff.
Added real invite-mode browser tests (`INVITE_E2E=1 pnpm exec playwright test`), using a separate local `tessaloom_e2e_invite` database and scripted providers. Anonymous starts are denied; invalid/expired/revoked codes are rejected; a valid one-run grant admits exactly one run and revocation prevents subsequent work. Existing mocked UI coverage remains as separate coverage.

Every gateway attempt (repair, truncation retry, client fallback) reserves first; SDK retries and unobservable server fallback are disabled. Unknown serving models retain their reservation. Durable per-run call and output-token reservations survive crashes, cancellation and retry. Global/workspace/experiment/run/grant USD reservations settle atomically and once; unknown billing retains the full reservation. A measured billing overrun sets a persistent `llm_billing_overrun` counter and blocks new calls until operator review. Resume/retry also rechecks access and concurrency. Read-only samples require explicitly featured active share links and omit private identifiers/access hashes; revoked/expired/private samples remain unavailable.

The byte-based reserve includes schema/protocol headroom and the highest cache/input rate. It is a conservative local estimate, **not a provider billing guarantee**. Price/model verification and provider-side hard spending limits remain mandatory before authorized live use; no live billing was tested.

Validation: build, lint, typecheck, migration journal check; 290 unit, 76 integration, 7 runtime, 28 Chromium/WebKit full E2E, 2 real invite E2E; browser-bundle check; production dependency audit, OSV, gitleaks history and current nonignored source; Docker build and complete container smoke all passed locally. Remote CI/CodeQL and hosted checks were not run. See verification report for scan scope and initial test failures.
