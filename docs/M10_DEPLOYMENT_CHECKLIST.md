# M10 production deployment checklist

> Updated during M10-A (2026-10-22). See [M10A_OPERATIONS.md](M10A_OPERATIONS.md) for procedures and [M10A_VERIFICATION.md](M10A_VERIFICATION.md) for local evidence. **Nothing here has been deployed.** Each item lists how to verify it. Items marked **(gap)** are not implemented yet and are M10 work. Owner actions (accounts, billing, secrets, DNS) need the project owner's authorization. No public deployment and no paid provider call may be started without it.

References: ARCHITECTURE §11 (deployment), ADR-017 (single service), ADR-018 (LLM credentials), SECURITY (all), TEST_PLAN §9 and §13, IMPLEMENTATION_PLAN M10.

## M10-B zero-cost option

The owner selected a single-VM, local persistent PostgreSQL option for preparation. See [M10B_DEPLOYMENT.md](M10B_DEPLOYMENT.md) and `deploy/compose.yml`. This option replaces the managed-Postgres/platform-TLS/PITR assumptions below with verified database TLS, Caddy, and operator-managed off-host backups. It requires explicit acceptance of the single-VM recovery tradeoff before public launch. All hosted checklist items remain unchecked.

## 1. Topology (ADR-017)

- [ ] **One** always-on service from the repository `Dockerfile`:
  - `TL_ROLE=all`, exactly **1 instance**, about 2 GB RAM;
  - scale-to-zero **disabled** through Nov 16 (buffer to Nov 30).

  pg-boss and the in-process SSE fan-out assume one instance.
- [ ] A managed PostgreSQL 16+ with TLS (`sslmode=require`), in the same region as the service.
- [ ] Platform start command: the image default (`tini -- node scripts/start.mjs`); `STOPSIGNAL SIGTERM` is honored.

## 2. HTTPS and `APP_ENV=production`

- [ ] Run with `APP_ENV=production` and `NODE_ENV=production`; the image defaults both.
  - `secureCookiesFor(APP_ENV)` makes every cookie `Secure` unless `APP_ENV` is `development` or `test`. Keep the confirmed local-HTTP vs production-HTTPS policy unchanged.
  - **Verify:** `curl -sI https://<host>/` shows `Set-Cookie: …; Secure; HttpOnly; SameSite=Lax` for the workspace cookie.
- [ ] TLS terminates at the platform. The public URL is `https://` only, and HTTP redirects to HTTPS.
- [ ] Production refuses fixtures: `QLOO_MODE=synthetic` and `LLM_PROVIDER=scripted` must fail the boot (fixture firewall, TEST_PLAN §9). **Verify** once on staging by booting with `QLOO_MODE=synthetic` and confirming the process exits.
- [ ] Global security headers (implemented and locally tested; verify again at the hosted URL):
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`;
  - a `Content-Security-Policy` with per-request script nonces and strict-dynamic; inline styles remain permitted;
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, and `frame-ancestors 'none'`.

  Headers are emitted by the runtime Next Proxy, including stricter share/sample policies; do not move environment-sensitive HSTS into build-time configuration. **Verify** with Playwright response assertions on every page (TEST_PLAN §9 "Headers and CSP").

## 3. Secrets and credentials (set in the platform's secret store, never in the image or repo)

| Variable | Process | Notes |
|---|---|---|
| `DATABASE_URL` | web + worker | The app role (DML only), TLS |
| `DATABASE_URL_MIGRATOR` | release step only | The DDL role; never passed to children (supervisor allowlist) |
| `SESSION_SECRET` | web only | ≥ 32 random bytes; never reaches the worker |
| `SHARE_TOKEN_PEPPER` | web only | ≥ 32 random bytes. **Rotating it invalidates every share link.** |
| `QLOO_API_KEY` | **worker only** | The web boot fails if it is set (deny-list); the supervisor never passes it to web |
| `ANTHROPIC_API_KEY` | **worker only** | Set a Console spend limit first (ADR-018) |
| `ADMIN_TOKEN` | web | Optional; long random value |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_FALLBACK_MODEL`, `LLM_MODE`, `QLOO_MODE=live`, `QLOO_RATE_LIMIT_PER_MIN`, the global daily Qloo quota | worker | Set the quota guard from the published hackathon quota |

- [ ] **Verify** worker-only credentials in the running container (container smoke, TEST_PLAN §9): `/proc/<web-pid>/environ` contains no `QLOO_API_KEY` or `ANTHROPIC_API_KEY`, and the worker env has no `SESSION_SECRET`, `SHARE_TOKEN_PEPPER`, or migrator URL.
- [ ] UID separation: when the platform starts the container as root, the supervisor drops to `tl-web` (10001) and `tl-worker` (10002), and `QLOO_HOME` is mode `0700`. If the platform forces a non-root start, record the residual risk (ADR-017).
- [ ] `QLOO_RAW_RETENTION=off` (the image default; R-08). No raw Qloo payloads are persisted.

## 4. PostgreSQL persistence and migrations

- [ ] Create two roles: `migrator` (owner, DDL) and `app` (SELECT/INSERT/UPDATE/DELETE on the app tables, no DDL).
- [ ] Release / pre-deploy step: `node packages/db/dist/migrate.mjs` with `DATABASE_URL=$DATABASE_URL_MIGRATOR`. It must finish before the new instance starts.
  - Migrations `0000`…`0007` apply in order (0007 adds demo grants and spend reservations). The release migrator holds a session advisory lock across app and queue setup, with bounded timeouts.
  - Migrations are additive and forward-only. Roll back only to an image that preserves WS-COST guards; a pre-guard image with paid credentials would bypass cost safety. Follow the runbook before restoring or replaying jobs.
- [ ] **Verify:** `pnpm db:check` passes in CI, and the `__drizzle_migrations` row count matches the journal after the release step.
- [ ] Backups: enable the provider's point-in-time recovery (≥ 7 days) and record the restore procedure. Test one restore into a scratch database before judging.
- [ ] **(gap)** Retention jobs: expired share links, old run events, the idempotency keys table.

## 5. Process supervision, health checks, restart, recovery

- [ ] The platform health check uses `GET /api/health/ready`. It returns 200 only when the database is reachable **and** the worker heartbeat is fresh, otherwise 503. `GET /api/health` is liveness only.
- [ ] Supervisor behavior (`scripts/start.mjs`), already unit-tested:
  - a crashed child restarts with exponential backoff (1 s → 30 s);
  - more than 5 crashes in 5 minutes stops the container with exit 1, so the platform restarts it;
  - SIGTERM drains both children.
- [ ] Run recovery: on worker restart, non-terminal runs resume from their last committed state (idempotent commits, M4). Runs waiting at a gate expire after 24 h. **Verify** on staging: kill the worker mid-run and confirm the run completes after the restart.
- [ ] Per-child heap limits implemented: web 512 MB and worker 768 MB old space by default. Size these with total RSS headroom for the hosted instance.
- [ ] Logging: JSON lines on stdout, shipped by the platform.
  - Do the redaction review before launch: no tokens, cookies, keys, share tokens, or raw Qloo payloads. The supervisor logs variable names only and pipes child stdout/stderr into redacted structured records; verify the actual platform log sink.
  - Set `LOG_LEVEL=info`.
- [ ] Alerting: the platform's health-check failure notification goes to the owner.

## 6. Production security validation (before the URL is shared)

- [ ] gitleaks over the **full history**: 0 findings.
- [ ] `pnpm audit --prod` and OSV-Scanner: no high or critical without a documented exception. CodeQL: no high alerts.
- [ ] `pnpm check:bundle`: no secret names or values in `.next/`.
- [ ] Re-run the share-link security checks against the deployed URL:
  - the token is shown once;
  - the response carries `noindex`, `no-referrer`, and `no-store`;
  - a revoked or expired token gets the uniform 404;
  - lookups return 429 after 30/min.
- [ ] Re-run the CSRF, cross-workspace (404), and rate-limit integration checks against staging config.
- [ ] Confirm the fixture banner is **absent** in production, and that no fixture record is served.
- [ ] Copy is honest everywhere: Qloo affinity is presented as an aggregate signal, never as proof of attendance, sales, or commercial success.

## Public demo cost safety and trusted ingress

- [ ] `RUN_ACCESS=invite` (default in staging/production); verify anonymous run creation is denied at the hosted URL. `off` is the kill switch; do not use `open` for anonymous paid generation without an explicit owner decision.
- [ ] Configure global/workspace/experiment/grant budgets and durable run/call/output limits; keep provider-side hard spend limits as an independent control. Validate prices before live calls.
- [ ] Exercise grant creation/redeem/revoke, expiration, one-run exhaustion and saved-view availability with approved testers; never record access codes in logs.
- [ ] Leave `TRUSTED_PROXY_HOPS=0` unless the ingress topology is verified. For explicit hops, block direct origin access and verify forged forwarding headers cannot change the limiter identity. Preserve public Host for CSRF.
- [ ] Verify the 64 KiB streaming body limit and rate limits at ingress and app; active rate buckets must not be evicted by key churn.
- [ ] Feature only reviewed active share links as public samples; check data scope, provenance labels, revocation and absence of private identifiers. Sample viewing must not enqueue work.
- [ ] Establish ledger/billing-overrun alerts and a reviewed reconciliation procedure. Unknown reservations remain charged; restoring a backup must not reset the effective paid allowance.

## 7. Live-provider prerequisites (owner authorization required; paid calls)

- [ ] The Qloo key is available and the quota is known. Run the live contract checks that are still PENDING (LC calibration, harness parameters for tag constraints and audience bands).
- [ ] The Anthropic key has a spend limit. Run one live EXPLORATION → COMPOSITION within the cost caps (EXPLORATION 2.00, COMPOSITION 0.70) and review the R1–R6 outputs. The live R6 quality is unverified (M9 used the scripted provider only).
- [ ] Sample projects S1–S3: run them live, pin their snapshots, and seed them into the `system` workspace in REPLAY mode (R-08 permitting).

## 8. Full cross-module E2E on the deployed environment

- [ ] TEST_PLAN §13 smoke tests on the public URL: health, project creation, a brief, a live run to H3, composition, export, share/revoke.
- [ ] One complete journey: Creative Brief → H1 → Discovery (H2/H2b) → Hypothesis Lab (H3) → What-if branch (H4) → blueprint from the branch → edit → Markdown export → share → revoke. Run it in Chromium and WebKit.
- [ ] A11Y-01…04 (axe, keyboard-only journey E2E-02 → E2E-09, focus visibility, contrast), plus a Lighthouse accessibility score (informational).
- [ ] A share link of a sample blueprint renders in a private browser context.

## 9. Known issues carried into M10

- The `pg` driver warns "client.query() when the client is already executing a query". The cause is `Promise.all` reads on a transaction client in the M8 comparison and orchestrator paths. It is harmless on pg 8 (queries are queued). Serialize those reads before any pg 9 upgrade.
- Optional blueprint gap-fill queries (≤ 4) are not implemented (ADR-028).
- Ad hoc resolution (`/resolve`) and REVALIDATION are not implemented (ADR-027).
