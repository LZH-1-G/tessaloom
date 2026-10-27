# Rollout: public judge demo on Gemini 3.8 Flash (Demo B, 2026-10-27)

Owner-approved. This followed the passed local synthetic workflow
([evidence](gemini-3.8-flash-e2e-2026-10-27.md)). The code was unchanged (`d5359b4`), and the
service variables stayed `staging` / `synthetic`.

| Time (UTC) | Step | Result |
| --- | --- | --- |
| 07:24 | New secret group `tessaloom-gemini` | Type `secret`, restricted to service `tessaloom`, one variable `GEMINI_API_KEY`. It was created from the local key file through a 0600 temporary file; the value was never printed or passed as an argument. |
| 07:24 | `tessaloom-llm-limits` | `llm-limits.demo-gemini-flash.json`, plus `GEMINI_PAID_TIER_APPROVED=on` and `GEMINI_PRICING_VERIFIED_AT=2026-10-27T07:20:00Z` (Google's page re-checked at 07:20) |
| 07:24–07:26 | Restart | COMPLETED; readiness 200 |

## Verification

- **Status:** `mode:"fixture"`, `qlooTransport:"synthetic"`, `llmConfigured:true`,
  `llmModel:"gemini-3.8-flash"`.
- **Environment:**
  - `APP_ENV=staging`, `QLOO_MODE=synthetic`, `RUN_ACCESS=open`.
  - `LLM_PROVIDER=gemini`, `LLM_MODEL=gemini-3.8-flash`.
  - `GEMINI_PAID_TIER_APPROVED=on`, `GEMINI_LIVE_DATA_APPROVED=off`.
  - Caps: `GLOBAL_DAILY_LLM_USD=1.00`, `WORKSPACE_DAILY_LLM_USD=0.50`,
    `EXPERIMENT_LLM_USD=0.50`, `GEMINI_MAX_REQUESTS=300`, runs `4/1/10`.
  - One `GEMINI_API_KEY` name and 0 `ANTHROPIC*` names.
- **Key isolation:** the supervisor gives the web child an allowlist without `*_API_KEY`
  (unit-tested; CI container smoke reads `/proc/<web-pid>/environ`).
- **Public smoke:** 7/7.
- **Spend before the journey:** 0.

## Public fresh-browser journey (07:27–07:30, one run)

- Interpretation, discovery, hypothesis generation, then two critic-requested revision rounds.
  All of these were real Gemini calls.
- The run ended `COMPLETED_WITH_LIMITS` at 07:29:46 during the second revision.
  - It most likely reached the exploration's 40 Qloo-call limit (synthetic transport); the exact
    reason is shown in the lab ribbon.
  - Hypotheses are kept, and the lab offers **Compose a blueprint**.
- The test driver waited only for the selection gate, so it stopped at its 5-minute timeout
  before composing. The driver now handles both endings (checked locally on the gate path).
- **Spend today after the run:** $0.0787.

## Rollback

- **To the $0 scripted demo:** `LIMITS demo-synthetic`, then `RESTART`; optionally delete the
  `tessaloom-gemini` secret group.
- **To the closed state:** see [rollout-d5359b4-demo-a](rollout-d5359b4-demo-a-2026-10-27.md).
- **Stop all new runs immediately:** `ACCESS off`.

## Final public acceptance (07:44–07:46 UTC, one owner-approved journey, $0.12 limit)

The previous limited run could not be resumed: composing needs the owning workspace's browser
cookie, which lived in the discarded test context. This was therefore one fresh journey, in a
new headless browser with no cookies, on the public URL. It had a spend guard (cancel above
$0.10 during exploration; compose only if $0.04 still fits under $0.12) and no retries.

| Elapsed | Step |
| --- | --- |
| 0–28 s | project → example brief → Gemini interpretation → confirm → synthetic discovery |
| 28–102 s | Gemini hypothesis generation and critique; the run reached the **selection gate** |
| 111–138 s | top hypothesis selected → Gemini blueprint composition |
| 138–155 s | checks (below) |

- **Blueprint:** "Quiet Hearth Nocturne at Harbor Lights".
- **Traceability:** "9 blocks · 4 citations, all resolve to stored evidence" (22% evidence-backed,
  22% AI interpretation, 56% speculation).
- **Composer:** "R6 blueprint composition → valid output (gemini-3.8-flash, 1 attempt)".
- **Markdown export:** 4,700 characters, with the FIXTURE labels present.
- **Read-only share link:** opens in a second fresh browser (HTTP 200) with the FIXTURE banner
  and its expiry. The URL is a bearer link and is not recorded here.
- **Added application-side spend:** **$0.0529**. Mid-run readings include open reservations,
  which settle down. Spend today is now $0.1316.
- **Provider outcomes:** no uncertain outcome and no retry.

Screenshots: `test-results/public-final/` (not committed; fictional data only).
