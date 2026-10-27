# Rollout: `d5359b4` and public judge Demo A (2026-10-27)

Owner-approved: merge PR #26, deploy the merge SHA, and switch the public site to Demo A
([DEMO_DEPLOYMENT.md](../submission/DEMO_DEPLOYMENT.md)).

| Time (UTC) | Step | Result |
| --- | --- | --- |
| 06:09 | Before | `production` / `live`, `RUN_ACCESS=off`, Anthropic selected without a key, every budget `0`, `llmConfigured:false`, spend `0` |
| 06:10 | Merge PR #26 | `d5359b417e00248700cc7a2a381c052d0c064c67`; Northflank build SUCCESS |
| 06:12–06:14 | Deploy `d5359b4` | COMPLETED; readiness 200; status unchanged (closed) |
| 06:14–06:16 | Service variables | Only `APP_ENV` → `staging` and `QLOO_MODE` → `synthetic`. The service-level names are unchanged: `APP_ENV`, `HOSTNAME`, `NODE_ENV`, `PORT`, `QLOO_API_KEY`, `QLOO_MODE`. Group and addon variables are untouched. |
| 06:16 | Groups | `tessaloom-llm-limits` = `llm-limits.demo-synthetic.json`; `tessaloom-run-access` = `open` |
| 06:17 | Restart | COMPLETED; readiness 200 |

## Verification

- **Status:** `mode:"fixture"`, `qlooTransport:"synthetic"`, `llmConfigured:true`,
  `llmModel:"scripted-demo"`.
- **Environment:** `APP_ENV=staging`, `QLOO_MODE=synthetic`, `RUN_ACCESS=open`,
  `LLM_PROVIDER=scripted`. Every `*_LLM_USD=0`. `GLOBAL_DAILY_QLOO_CALLS=2000`. Runs `4/1/10`.
  `GEMINI_MAX_REQUESTS=0`. 0 `ANTHROPIC*` and 0 `GEMINI_API_KEY` names.
- **Public smoke** (`deploy/public-smoke.mjs`, no write probe): 7/7.
- **Fresh headless browser context, full judge journey on the public URL:** home → project →
  example brief → interpretation → discovery → hypotheses → evidence → composed blueprint, in
  42 s. The banner reads "FIXTURE — not real Qloo data · Scripted AI demo: no language model is
  called".
- **Spend today:** `0`.

## Rollback to the closed state

1. `ACCESS off`.
2. `LIMITS closed`.
3. Restore the two service variables, `APP_ENV=production` and `QLOO_MODE=live`, keeping the
   other four service-level variables unchanged.
4. `RESTART`.
5. `STATUS` should read `"mode":"live","llmConfigured":false`.

For a code regression, re-pin `859cd9f6dee33b4c7faf252180c3d17edf32cc32` with the deployment
command in [rollout-859cd9f](rollout-859cd9f-2026-10-27.md).
