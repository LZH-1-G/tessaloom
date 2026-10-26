# Final release handoff — 2026-10-26 (updated after repository publication)

Legend: **VERIFIED** (observed, with evidence) · **PREPARED** (ready, not executed) · **BLOCKED**
(needs an approval or an external action) · **NOT EXECUTED** (deliberately not run).

Deadline: **Oct 30, 2026, 11:45 PM ET** (Oct 31, 11:45 AM Beijing). Judging: **Nov 2–5, 2026**
([official rules](https://qloo.devpost.com/rules), read 2026-10-26).

## Dashboard

| Item | Status | Evidence |
| --- | --- | --- |
| Git: `main` | VERIFIED | `51be618` = PR #22 merge commit (merged 12:18 UTC, pinned to verified head `0ef7b4e`). PR #21 carries docs, one test fixture change, a new unit test and the prepared limit groups; no runtime code, so merging needs no rollout |
| CI on PR #22 | VERIFIED | Head `0ef7b4e`: push run all success; pull_request run attempt 1 hung in `playwright install` for 30 min before any test, was cancelled and re-run, and attempt 2 passed every job (e2e, integration, docker, lint-typecheck, unit, security; CodeQL skipped while private). Zero non-green checks at merge |
| Northflank build | VERIFIED | Build `spotted-self-1077` for `51be618` SUCCESS 12:20 UTC |
| Production deployment | VERIFIED: **`51be618`** | Manual rollout of exactly `51be618` (`update service deployment`, `buildSHA` pinned); deployment COMPLETED 12:22 UTC; `deployedSHA` = `buildSHA` = `51be618` |
| Health and worker | VERIFIED | New instance logs: `worker_queue_connection` verified (`databaseCreate:false`), `worker_queues_started` `llm:"unconfigured"`, `qlooMode:"live"`; 0 error lines; old instance stopped with SIGTERM during rollout |
| Qloo readiness | VERIFIED | New instance: `ready:true`, `endpointTrusted:true`, Harness 0.1.26; status `qlooReady:true` over the public URL |
| Private production smoke (zero paid calls) | VERIFIED | `northflank forward service --skipHostnames` (loopback only, hosts file untouched), then `deploy/public-smoke.mjs` read-only checks 7/7 pass: security headers incl. HSTS and nonce CSP, readiness booleans only, status `llmConfigured:false` + `llmModel:null`, no fixture samples, constant 404s, 401 for private data, 404 admin/source paths, CSRF refusal. Static assets 200 with immutable caching. No write probe run against production |
| Northflank CLI auth/RBAC | VERIFIED (workaround) / BLOCKED (least-privilege token) | The existing team-scope CLI token reads services/logs **and port-forwards**. The custom role's absence from the token dropdown is unexplained: docs say tokens inherit an RBAC role and that only members assigned to a role can create tokens from it; older docs describe separately created API roles. Confirm the role was created as a team RBAC role (not an org role) and that you, the token creator, are assigned to it; otherwise ask Northflank support. Replace the current token with a least-privilege one when the dropdown works |
| Run access in production | VERIFIED: **off** | Config group `tessaloom-run-access` (type config, restricted to service `tessaloom`, only `RUN_ACCESS=off`; no existing variable or secret read or changed). `child_start` env names include `RUN_ACCESS` for web and worker; `northflank exec … printenv RUN_ACCESS` → `off` |
| Public URL | VERIFIED | **https://p01--tessaloom--mpfcqkyl42yb.code.run**: port `p01` public since ~12:24 UTC (same name, port 3000, HTTP, no policies, Northflank domain). HTTPS certificate verifies, HTTP/2; plain HTTP → 301 to HTTPS |
| Anonymous visits | VERIFIED (by design) | Any browser visit to the studio creates an anonymous workspace row (`/api/v1/workspace`), rate-limited. Device checks therefore block those calls in the test browser so smoke testing writes nothing |
| Public-demo resilience fix | VERIFIED (PR #22 merged and live) | Verified defect: with workspace creation throttled (shared 20/min bucket), the studio showed "Qloo unavailable" and a raw "Load failed" while healthy. PR #22 decouples public status from the workspace bootstrap and adds readable 429/network messages; new Chromium + WebKit test fails before, passes after; full E2E 32 + invite 2 + unit 466 green |
| No-write device checks | PREPARED, rehearsed | `deploy/public-render-check.mjs` (PR #22): Chromium + WebKit, desktop 1440 and mobile 390, blocks workspace/project calls; local rehearsal 200, no overflow, no CSP violations, **0 workspace rows** created |
| Public security review | VERIFIED (code + local) | Every run-creating route passes admission; comparisons are template-only; no HTTP admin route; `ADMIN_TOKEN` unused by the web app; cookies HttpOnly/SameSite=Lax/Secure; shared exports no longer carry internal IDs (fixed + test). Residual: shared rate-limit bucket with `TRUSTED_PROXY_HOPS=0` |
| Public smoke (no records, no paid calls) | VERIFIED | `deploy/public-smoke.mjs <url>` (strict, HSTS required): 7/7 pass. Headers: HSTS `max-age=31536000; includeSubDomains`, nonce CSP, `X-Frame-Options: DENY`, nosniff, referrer and permissions policies. Anonymous probes: 7 write/run/redeem endpoints → 403 `CSRF_FAILED`; 5 private reads → 401 `WORKSPACE_REQUIRED`; cross-origin POST with a forged token pair → 403. `llmConfigured:false`, `llmModel:null`, samples `[]` |
| Public device checks | VERIFIED | `deploy/public-render-check.mjs`: Chromium + WebKit × desktop 1440 / mobile 390 → 200, no horizontal overflow, 0 CSP violations, workspace call blocked (no record). Status stays truthful without a workspace (PR #22 live) |
| Anthropic credentials | VERIFIED absent | `ANTHROPIC_API_KEY` absent from web and worker env names; container has 0 variable names starting `ANTHROPIC` or `CLAUDE_` |
| Spending guard | VERIFIED (tests) | Fallback + queue retries share one global ledger: provider calls = reservations = invocations; unknown outcomes stay charged; a refused reservation never reaches the provider (`tests/integration/spend-retries.test.ts`) |
| Full-workflow run admissions | VERIFIED defect, FIXED in runbook | Composition is a second run admission; `WORKSPACE_DAILY_RUNS=1` / `--runs 1` would refuse Compose (`429 RUN_LIMIT`, test). Runbook and template now use 2 |
| Real Qloo + Claude workflow | VERIFIED locally only | 2026-10-26 local run (subscription, $0 API): [report](../CLAUDE_SUBSCRIPTION_LOCAL_ACCEPTANCE.md). **Not** a production result |
| Public story sample | PREPARED / BLOCKED | Feature built and tested (Chromium + WebKit). Production has **0 samples**; the first comes from the paid acceptance run |
| Judge access (interactive) | PREPARED | Runbook §5.2: 4 capped codes (14 days, 6 runs, $1 each) created **by Oct 29** so Devpost testing instructions work before the Oct 30 deadline and through Nov 5; `RUN_ACCESS=invite`, daily caps $4, Console limit $15 |
| Qloo data rights | PREPARED / BLOCKED (organizer reply) | [DATA_RIGHTS_REVIEW.md](DATA_RIGHTS_REVIEW.md): uncertain fields (popularity/affinity, descriptions, IDs, raw responses) absent from all public payloads and exports; question drafted |
| GitHub publication | VERIFIED | **Public since 2026-10-26** after a final full-history audit ([PUBLIC_READINESS.md](PUBLIC_READINESS.md)): gitleaks clean, no PII or tokens, no Qloo payloads; one opaque Qloo-style fixture ID replaced in the tree. Logged-out 200, "MIT License" detected, homepage = demo URL, secret scanning and push protection on |
| LLM and budget variables in production | VERIFIED unset → **fixed: closed limits applied 12:54 UTC** | `printenv` shows every model/budget variable unset, so code defaults apply (Opus, $15/day, 20 runs/day). Harmless now (no key, `RUN_ACCESS=off`), but adding a key first would use them. Runbook §2.2 now pins limits with config group `tessaloom-llm-limits` **before** the key; payloads in `deploy/northflank-groups/`, checked by `tests/unit/northflank-groups.test.ts`. Applied: `printenv` shows Sonnet only, every budget `0`, Qloo calls `0`, `RUN_ACCESS=off`; restart on `51be618`, Qloo ready, 0 errors, public smoke 7/7 |
| PR #21 | VERIFIED merged | `79d2d84` (merge commit) after 15/15 checks green on `71a1c9e`. Northflank built it (SUCCESS 12:59 UTC) but did not roll out: `deployedSHA` stays `51be618` (docs/tests only) |
| Devpost gallery | PREPARED | Five real-data screenshots from the local run (web-only, no calls), Qloo IDs redacted, captions in [DEMO_SCRIPT.md](DEMO_SCRIPT.md); delivered to the owner, not committed |
| In-app Qloo IDs | VERIFIED finding, disclosed | The studio evidence drawer and trace show the Qloo entity ID / tag URN behind each grading (signed-in users only; never in public payloads). Added to the Qloo request; redact in screenshots and video |
| Devpost | PREPARED | [DEVPOST.md](DEVPOST.md): demo and repo links filled and verified; technical description; submission checklist; fallback testing text. Remaining placeholders `[RUN_DATE]`, `[PRODUCTION_RESULT]`, `[JUDGE_CODE_n]`, `[CODE_EXPIRY]`. Video optional; [script](DEMO_SCRIPT.md) ready |
| Production inference config | VERIFIED unconfigured | No `LLM_PROVIDER`/key in the worker environment (`child_start` env names); status `llmConfigured:false` |
| Paid model spending | VERIFIED **$0** | No Anthropic key exists for this project; no API calls made. Local acceptance used the owner's subscription ($0 API charge) |
| Final paid acceptance | NOT EXECUTED | Runbook §2.2–§4: zero-budget limits group, then dedicated Console workspace + key with a $15 limit, then one Spirited Away + Joe Hisaishi run, ≈ $0.14 expected, ≤ $0.50 ledger, evidence via `admin.mjs report project` |

## Approvals needed, in order

1. Send the Qloo request ([QLOO_PERMISSION_REQUEST.md](QLOO_PERMISSION_REQUEST.md)).
2. ~~Make the GitHub repository public~~ (done 2026-10-26).
3. ~~Runbook §2.2: zero-budget limits group~~ (done 2026-10-26 12:54 UTC, verified).
4. Runbook §3: Console workspace, $15/month limit, key in secret group `tessaloom-anthropic`.
5. **By Oct 29:** the single paid acceptance (§4). It creates the public story sample (§5.1).
6. **By Oct 29:** the four judge codes, judging limits and `RUN_ACCESS=invite` (§5.2); redeem one.
7. **By Oct 30, 11:45 PM ET:** fill the Devpost placeholders, then final approval to submit.

## Rollback

- **Code:** revert the merge commit on `main` (`git revert -m 1 <sha>`), or redeploy deployment
  `6aded5c0351e0f7052ed6dbd` (`39c0fe5`) from the Northflank UI. No migrations since `39c0fe5`.
- **Exposure:** set port `p01` back to private (`update service ports` with `public:false`, same port definition).
- **Run access:** set `RUN_ACCESS=off` in config group `tessaloom-run-access`. Do not delete the group: unset means `invite` in production.
- **Spending:** `RUN_ACCESS=off`, `tessaloom-llm-limits` back to `llm-limits.closed.json`, revoke
  grants (`admin.mjs grant revoke`), delete secret group `tessaloom-anthropic` and revoke the key
  in the Console, restart, then check `spend today` against the Console.
- **Repository:** `gh repo edit LZH-1-G/tessaloom --visibility private --accept-visibility-change-consequences`
  (stars and forks are lost; forks made while public stay public).
