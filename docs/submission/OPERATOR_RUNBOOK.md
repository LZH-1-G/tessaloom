# Operator runbook: paid acceptance, judge access, rollback

The single executable procedure for every remaining production step. The reasoning behind each
cap is in [PRODUCTION_FIRST_RUN.md](PRODUCTION_FIRST_RUN.md); this file is only what to run and
what to expect. Commands were checked on 2026-10-27 against production (read-only ones were run;
write ones are marked **writes** and have **not** been run).

**State on 2026-10-27:** `859cd9f` deployed (02:21 UTC; rollback target `51be618`); `RUN_ACCESS=off`; config group
`tessaloom-llm-limits` = closed set (Sonnet 5.5 only, every budget `0`, Qloo calls `0`); no
`ANTHROPIC*` variable; `spend today` = `0`; 0 grants; 0 samples.

**Cost and its limits.** One full workflow is expected to cost about **$0.14** (local token
measurement at list price). The application caps it at **$0.50** by reserving each attempt's
upper bound before sending it. That ledger is an **estimate kept by the application, not a
provider guarantee**: token counts come from the API response and prices from a table in the
code. The Console workspace spend limit is the independent backstop, and even that can lag
usage reporting. Never rely on one layer alone.

## Shorthands

Run from the repository root with the Northflank CLI signed in.

```bash
NFX() { northflank exec service --project default --service tessaloom --cmd "sh -c '$1'" 2>&1 | grep -v '^Exec service'; }
ADMIN() { NFX "cd /app && node packages/db/dist/admin.mjs $1"; }
LIMITS() { node -e 'const g=require("./deploy/northflank-groups/llm-limits.'"$1"'.json");console.log(JSON.stringify({secrets:g.secrets}))' > /tmp/tl-limits.json && northflank update secret --project default --secretId tessaloom-llm-limits --input "$(cat /tmp/tl-limits.json)"; }
ACCESS() { northflank update secret --project default --secretId tessaloom-run-access --input "{\"secrets\":{\"variables\":{\"RUN_ACCESS\":\"$1\"}}}"; }
RESTART() { northflank restart service --project default --service tessaloom; }
SHOWENV() { NFX 'for v in RUN_ACCESS LLM_MODEL GLOBAL_DAILY_LLM_USD WORKSPACE_DAILY_LLM_USD EXPERIMENT_LLM_USD GLOBAL_DAILY_QLOO_CALLS MAX_WORKING_RUNS MAX_ACTIVE_RUNS_PER_WORKSPACE WORKSPACE_DAILY_RUNS; do printenv $v | sed "s/^/$v=/"; done; echo ANTHROPIC_names=$(env | cut -d= -f1 | grep -c ^ANTHROPIC)'; }
STATUS() { curl -s https://p01--tessaloom--mpfcqkyl42yb.code.run/api/v1/system/status; echo; }
```

After every `RESTART`, wait until Northflank shows the deployment **COMPLETED** (about 90 s)
before `SHOWENV`. `SHOWENV` prints values of non-secret variables only, and only the **count** of
`ANTHROPIC*` names.

## A. Owner only: Console and key (no spend)

1. Claude Console → create workspace `tessaloom` → set its **spend limit to $15/month** →
   create one API key in it. Never paste the key into chat, the repository, a terminal command,
   build arguments or logs.
2. Northflank → Secret groups → **Create** → type **Secret**, name `tessaloom-anthropic`,
   restricted to service `tessaloom` only, one variable `ANTHROPIC_API_KEY` (paste the key
   here only).
3. `RESTART`, then check:

| Command | Expected |
| --- | --- |
| `SHOWENV` | `RUN_ACCESS=off`, `LLM_MODEL=claude-sonnet-5-5`, every `*_LLM_USD=0`, `GLOBAL_DAILY_QLOO_CALLS=0`, `ANTHROPIC_names=1` |
| `STATUS` | `"llmConfigured":true,"llmModel":"claude-sonnet-5-5"`, `"qlooReady":true` |
| `ADMIN "spend today"` | `"globalLlmUsdToday": 0` |

**Stop** if `ANTHROPIC_names` is not `1`, the model is not `claude-sonnet-5-5`, or any budget
is not `0`. Nothing can spend at this point: access is off and every budget is zero.

## B. Go / no-go for the paid run

All must be true, or do not continue:

- [ ] Section A passed today.
- [ ] `node deploy/public-smoke.mjs https://p01--tessaloom--mpfcqkyl42yb.code.run` → 7/7.
- [ ] The owner has written, in chat, approval for **this one run**.

## C. The single paid acceptance (**writes**, **spends ≤ $0.50**)

1. `LIMITS acceptance` and `ACCESS invite`, then `RESTART`.
2. `SHOWENV` → `RUN_ACCESS=invite`, `GLOBAL_DAILY_LLM_USD=0.50`, `WORKSPACE_DAILY_LLM_USD=0.50`,
   `EXPERIMENT_LLM_USD=0.50`, `GLOBAL_DAILY_QLOO_CALLS=60`, `MAX_WORKING_RUNS=1`,
   `MAX_ACTIVE_RUNS_PER_WORKSPACE=1`, `WORKSPACE_DAILY_RUNS=2`. **Stop** on any difference.
3. `ADMIN "grant create --label final-acceptance --days 1 --runs 2 --usd 0.50"` → JSON with
   `grantId`, `maxRuns: 2`, `maxLlmUsd: 0.5` and a one-time `code`. Keep the code private; note
   the `grantId`. Two runs = exploration + composition (one workflow).
4. Fresh private browser window, recording off →
   https://p01--tessaloom--mpfcqkyl42yb.code.run → **Unlock AI runs** → enter the code →
   expect "Demo access active".
5. Create project **Spirited sound evenings**, use case **Café**. Brief: title _Spirited sound
   evenings_; challenge _"A 40-seat café wants a recurring monthly weekday evening that brings
   animated-film lovers and film-score music fans together, to attract new regular visitors on a
   quiet night."_; interests **Spirited Away** (Film) and **Joe Hisaishi** (Music artist);
   capacity 40; low budget; 90 minutes; goal _Attract new weekday regulars_.
   **Interpret brief** → **Confirm & discover**.
6. Entities: **Spirited Away (2001)** and **Joe Hisaishi** → **Confirm choices**.
7. Accept the proposed pool → **Generate hypotheses**. If it stops with too few bridges, stop
   the procedure and go to E (record it; do not retry under this approval).
8. Select the top supported hypothesis → **Compose blueprint** → **Recurring series** →
   **Compose blueprint**.
9. Go straight to D.

**Stop at once (go to D) on:** a refused reservation, any provider authentication or 4xx error,
a model other than `claude-sonnet-5-5` in the Decisions panel, `ADMIN "spend today"` above
`0.50`, or anything unexpected. Never retry under the same approval.

**Pass:** every stage completes; every model call is valid (one repair allowed); all blueprint
citations resolve with origin "Qloo (live)"; `spend today` ≤ 0.50 and within rounding of the
Console usage page.

## D. Close the run (immediately, pass or fail)

1. `ADMIN "grant revoke <grantId>"` → `"revoked": true`.
2. `ACCESS off` and `LIMITS closed`, then `RESTART`; `SHOWENV` → `RUN_ACCESS=off`, budgets `0`.
3. `ADMIN "spend today"` and compare with the Console usage page.
4. Evidence (no secrets, prompts, outputs or Qloo payloads):
   `ADMIN "report project <projectId>" > docs/evidence/production-acceptance-<YYYY-MM-DD>.json`
   (the project id is in the project URL). Add a short Markdown note with `spend today`, the
   Console charge and the pass criteria; commit both through a PR.

## E. Public story sample (no spend)

1. On the blueprint page: **Share read-only** → **The whole story** → expiry **30 days** →
   **Create link**. Copy the **Link ID** shown in the dialog (not the link itself).
2. `ADMIN "sample feature <Link ID>"` → `"updated": true`.
3. `curl -s https://p01--tessaloom--mpfcqkyl42yb.code.run/api/v1/samples` → one item; open it
   from **Demo samples** in a fresh window, with no code.
4. Withdraw any time with `ADMIN "sample unfeature <Link ID>"`.

## F. Judge access (**writes**; by Oct 29, after C passed and the owner approves)

1. `LIMITS judging` and `ACCESS invite`, then `RESTART`.
2. `SHOWENV` → `RUN_ACCESS=invite`, `GLOBAL_DAILY_LLM_USD=4.00`, `WORKSPACE_DAILY_LLM_USD=1.00`,
   `EXPERIMENT_LLM_USD=1.00`, `GLOBAL_DAILY_QLOO_CALLS=400`, `MAX_WORKING_RUNS=2`,
   `MAX_ACTIVE_RUNS_PER_WORKSPACE=1`, `WORKSPACE_DAILY_RUNS=6`.
3. Four times, `n` = 1…4: `ADMIN "grant create --label judge-n --days 14 --runs 6 --usd 1.00"`.
   Each prints a one-time code (6 runs = 3 full workflows, $1 lifetime cap, expires 14 days
   later, so about Nov 12 when created Oct 29). Put the codes and expiry into Devpost's testing
   field only.
4. Fresh private window → **Unlock AI runs** → enter `judge-1`'s code → "Demo access active".
   Start nothing: redemption costs nothing.
5. `ADMIN "grant list"` → four active grants.

Rehearsed on 2026-10-27 against a scratch local database with the same CLI and a local
invite-mode server: anonymous start refused (`403 RUN_ACCESS_REQUIRED`), a redeemed code admits a
run (`202`), a second concurrent run refused (`429 RUN_LIMIT`), another workspace cannot read the
project (`404`), revoked and expired codes return the same `400`, `grant list` and `spend today`
correct, `report project` contains no prompt or output text.

**During judging (Nov 2–5), once a day:** `ADMIN "spend today"`, `ADMIN "grant list"`, the
Console usage page, `STATUS`, and `node deploy/public-smoke.mjs <url>`. Revoke and replace any
code that spends abnormally.

**After judging:** revoke all four grants, `ACCESS off`, `LIMITS closed`, `RESTART`; delete the
`tessaloom-anthropic` group and revoke the key in the Console. The story sample can stay.

## Rollback

| Situation | Action |
| --- | --- |
| Anything unexpected during C or F | `ACCESS off` → `RESTART`. Stops every new run at once; saved work and samples stay readable |
| Spending looks wrong | `ACCESS off`, `LIMITS closed`, `RESTART`; `ADMIN "grant revoke <id>"` for each grant; revoke the key in the Console (works even if Northflank is unreachable) |
| One code leaked or misused | `ADMIN "grant revoke <id>"` (immediate); issue a replacement only if needed |
| Bad sample | `ADMIN "sample unfeature <Link ID>"` |
| Code regression | Re-pin build `51be618`: `northflank update service deployment --project default --service tessaloom --input '{"internal":{"id":"tessaloom","branch":"main","buildSHA":"51be618ed54371798db2a51f84ef83e305aba9eb"},"docker":{"configType":"default"}}'`. No migrations since `39c0fe5` |
| Exposure must end | Port `p01` → private (`update service ports`, same definition, `public:false`) |

Never delete `tessaloom-run-access`: an unset `RUN_ACCESS` means `invite` in production.
