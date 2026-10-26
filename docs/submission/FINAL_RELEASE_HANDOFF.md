# Final release handoff — 2026-10-26 (~11:00 UTC)

Legend: **VERIFIED** (observed, with evidence) · **PREPARED** (ready, not executed) · **BLOCKED**
(needs an approval or an external action) · **NOT EXECUTED** (deliberately not run).

Deadline: **Oct 30, 2026, 11:45 PM ET** (Oct 31, 11:45 AM Beijing). Judging: **Nov 2–5, 2026**
([official rules](https://qloo.devpost.com/rules), read 2026-10-26).

## Dashboard

| Item | Status | Evidence |
| --- | --- | --- |
| Git: `main` | VERIFIED | `a37afc6` = PR #19 merge commit; clean tree; release branch `claude/release-validation` adds only tests, two security scripts and docs (no `apps/`/`packages/` changes) |
| CI on `main` `a37afc6` | VERIFIED | GitHub Actions run 40282848054: lint-typecheck, unit, integration, e2e (Chromium + WebKit), docker (image smoke, Linux AMD64), security: all success; CodeQL skipped while the repo is private |
| CI on this release branch | See its PR | Local on the branch head: lint, typecheck, unit 466, integration 96, gitleaks range clean |
| Production deployment | VERIFIED | Northflank `default/tessaloom` runs `a37afc6`, deployment `6adf02088a11dc200a3ad9ee`, build SUCCESS, deployment COMPLETED 07:33 UTC, 1 instance `nf-compute-20` |
| Health and worker | VERIFIED | Logs: `worker_queue_connection` verified with `databaseCreate:false`, `schemaCreate:false`; `worker_queues_started` `llm:"unconfigured"`, `qlooMode:"live"`. Readiness 200 through private forward |
| Qloo readiness | VERIFIED | 39/39 probes 07:32–10:42 UTC: `ready:true`, `endpointTrusted:true`, Harness 0.1.26, `probeFailure:null` |
| Private production smoke (zero paid calls) | VERIFIED | `northflank forward service --skipHostnames` (loopback only, hosts file untouched), then `deploy/public-smoke.mjs` read-only checks 7/7 pass: security headers incl. HSTS and nonce CSP, readiness booleans only, status `llmConfigured:false` + `llmModel:null`, no fixture samples, constant 404s, 401 for private data, 404 admin/source paths, CSRF refusal. Static assets 200 with immutable caching. No write probe run against production |
| Northflank CLI auth/RBAC | VERIFIED (workaround) / BLOCKED (least-privilege token) | The existing team-scope CLI token reads services/logs **and port-forwards**. The custom role's absence from the token dropdown is unexplained: docs say tokens inherit an RBAC role and that only members assigned to a role can create tokens from it; older docs describe separately created API roles. Confirm the role was created as a team RBAC role (not an org role) and that you, the token creator, are assigned to it; otherwise ask Northflank support. Replace the current token with a least-privilege one when the dropdown works |
| Public URL | BLOCKED | Port `p01` is `public:false`; `p01--tessaloom--mpfcqkyl42yb.code.run` does not answer externally. Needs approval (runbook §2.1 steps 6–8) |
| Public security review | VERIFIED (code + local) | Every run-creating route passes admission; comparisons are template-only; no HTTP admin route; `ADMIN_TOKEN` unused by the web app; cookies HttpOnly/SameSite=Lax/Secure; shared exports no longer carry internal IDs (fixed + test). Residual: shared rate-limit bucket with `TRUSTED_PROXY_HOPS=0` |
| Spending guard | VERIFIED (tests) | Fallback + queue retries share one global ledger: provider calls = reservations = invocations; unknown outcomes stay charged; a refused reservation never reaches the provider (`tests/integration/spend-retries.test.ts`) |
| Full-workflow run admissions | VERIFIED defect, FIXED in runbook | Composition is a second run admission; `WORKSPACE_DAILY_RUNS=1` / `--runs 1` would refuse Compose (`429 RUN_LIMIT`, test). Runbook and template now use 2 |
| Real Qloo + Claude workflow | VERIFIED locally only | 2026-10-26 local run (subscription, $0 API): [report](../CLAUDE_SUBSCRIPTION_LOCAL_ACCEPTANCE.md). **Not** a production result |
| Public story sample | PREPARED / BLOCKED | Feature built and tested (Chromium + WebKit). Production has **0 samples**; the first comes from the paid acceptance run |
| Judge access (interactive) | PREPARED | Runbook §5.2: 4 capped codes (14 days, 6 runs, $1 each) created **by Oct 29** so Devpost testing instructions work before the Oct 30 deadline and through Nov 5; `RUN_ACCESS=invite`, daily caps $4, Console limit $15 |
| Qloo data rights | PREPARED / BLOCKED (organizer reply) | [DATA_RIGHTS_REVIEW.md](DATA_RIGHTS_REVIEW.md): uncertain fields (popularity/affinity, descriptions, IDs, raw responses) absent from all public payloads and exports; question drafted |
| GitHub publication | PREPARED | [PUBLIC_READINESS.md](PUBLIC_READINESS.md): history clean, no secrets/PII/Qloo data, MIT detected. Visibility change awaits approval |
| Devpost | PREPARED | [DEVPOST.md](DEVPOST.md) with compliance matrix; placeholders `[PUBLIC_URL]`, `[RUN_DATE]`, `[PRODUCTION_RESULT]`, `[JUDGE_CODE_n]`, `[CODE_EXPIRY]`. Video optional; [script](DEMO_SCRIPT.md) ready |
| Production inference config | VERIFIED unconfigured | No `LLM_PROVIDER`/key in the worker environment (`child_start` env names); status `llmConfigured:false` |
| Paid model spending | VERIFIED **$0** | No Anthropic key exists for this project; no API calls made. Local acceptance used the owner's subscription ($0 API charge) |
| Final paid acceptance | NOT EXECUTED | Runbook §3–§4: dedicated Console workspace + key, $15 limit, one Spirited Away + Joe Hisaishi run, ≈ $0.14 expected, ≤ $0.50 ledger, evidence via `admin.mjs report project` |

## Approvals needed, in order

1. Merge this release PR (docs and tests only; deploys automatically with no runtime change).
2. Make port `p01` public, then run the public smoke (runbook §2.1 steps 6–8).
3. Make the GitHub repository public.
4. Create the dedicated Anthropic key with a Console spend limit, then run the single paid
   acceptance (§3–§4). This also creates the public story sample (§5.1).
5. Issue the judge codes and set `RUN_ACCESS=invite` (§5.2) **by Oct 29**, verify one redemption, and put them in the Devpost testing instructions before submitting.
6. Send the organizer data-rights question; fill Devpost placeholders; submit by Oct 30 ET.

## Rollback

- **Code:** revert the merge commit on `main` (`git revert -m 1 <sha>`), or redeploy deployment
  `6aded5c0351e0f7052ed6dbd` (`39c0fe5`) from the Northflank UI. No migrations since `39c0fe5`.
- **Exposure:** set port `p01` back to private.
- **Spending:** `RUN_ACCESS=off`, budgets `0`, revoke grants (`admin.mjs grant revoke`), remove
  `ANTHROPIC_API_KEY`, and check `spend today` against the Console.
