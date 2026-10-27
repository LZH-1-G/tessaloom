# Gemini API migration: paid-capable provider, rollout and rollback

Status on 2026-10-27: **implemented and tested offline only.** No Gemini request (metadata or
generation) was made. No paid call, deployment, Northflank change, secret, budget or
`RUN_ACCESS` change was made. Production still runs Claude Sonnet 5.5 through the Anthropic API.
The `tessaloom-llm-limits` config group pins `LLM_PROVIDER=anthropic` there.

## What changed

| Area | Change |
| --- | --- |
| Billing tiers | `GeminiProvider` accepts exactly one tier. **Free** needs `GEMINI_FREE_TIER_CONFIRMED` plus `GEMINI_DATA_SHARING_APPROVED` (unchanged), costs settle at $0, and the cap is at most 50 requests per worker lifetime. **Paid** needs `GEMINI_PAID_TIER_APPROVED=on` plus `GEMINI_PRICING_VERIFIED_AT`, settles actual cost at published rates, and allows up to 5,000 requests per UTC day per worker process. Both on, or neither, means no Gemini gateway. |
| Pricing review | `GEMINI_PRICING_VERIFIED_AT` records when the owner checked the code's price table against Google's page. It must be on or after `GEMINI_PRICE_REVIEW` (2026-10-26), not in the future, and at most 90 days old. Once it expires, paid calls pause **without sending** until the owner re-attests. |
| Live data | New `GEMINI_LIVE_DATA_APPROVED` (default `off`, paid tier only). Without it the gateway refuses every input not attested as synthetic. The refusal happens before reservation, recording or any network request. Production always uses live Qloo (`QLOO_MODE=live`), so **production Gemini does nothing until this permission is verified and set.** |
| Pricing | `providers/gemini-pricing.ts` holds a dated schedule for each approved model. The worker passes `geminiPrices`, and the gateway takes one rate snapshot per `generate()` call, so a reservation and its settlement always use the same rates. Scheduled-price models are excluded from the clockless static `PRICES`, which makes a gateway without the schedule fail closed (`UNPRICED_MODEL`). |
| Accounting | `toolUsePromptTokenCount` is billed as input (no tools are sent, so it should be 0). Thinking tokens are billed as output and reported as `reasoningTokens`. `totalTokenCount` must equal prompt + tool-use prompt + thoughts + candidates. A response whose `usageMetadata.serviceTier` is anything other than standard is rejected. |
| Paid accounting latch | On the paid tier, an invalid envelope, inconsistent usage, a non-standard service tier or an unexpected serving model keeps the full reservation charged. It also latches further Gemini calls off until the worker restarts. |
| Models | Approved IDs: `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.6-flash`, `gemini-3.8-flash`, plus legacy `gemini-2.5-flash-lite` and `gemini-2.5-flash`. Preview models are excluded. Nothing selects a model automatically, and there is no fallback model or provider. |
| Production guards | The worker environment rejects the free tier in production, both tiers at once, paid without a pricing date, live data without paid, and more than 50 free-tier requests. The Claude subscription provider remains refused outside development and test. |
| Unchanged | The M10-A spend ledger: per-attempt reservations, global, workspace, experiment, run and grant caps, the billing-overrun alarm, `RUN_ACCESS` (including `off` as the kill switch), run admission limits, the per-run call and token budgets, the Anthropic, DeepSeek and scripted providers, the live Qloo integration, and the web environment's refusal of `*_API_KEY`. |

## Verified against Google's documentation (2026-10-27)

Sources: [models](https://ai.google.dev/gemini-api/docs/models) (updated 2026-10-22),
[pricing](https://ai.google.dev/gemini-api/docs/pricing) (updated 2026-10-26),
[generateContent reference](https://ai.google.dev/api/generate-content),
[structured output](https://ai.google.dev/gemini-api/docs/structured-output),
[thinking](https://ai.google.dev/gemini-api/docs/thinking),
[Gemini 3 guide](https://ai.google.dev/gemini-api/docs/generate-content/gemini-3),
[service tiers](https://ai.google.dev/gemini-api/docs/optimization).

Paid Tier, Standard, text, USD per 1M tokens (output includes thinking tokens):

| Model | Status | Free tier | Input | Cached input | Output | Default thinking |
| --- | --- | --- | --- | --- | --- | --- |
| `gemini-3.5-flash-lite` | Stable | Yes | 0.30 | 0.03 | 2.50 | minimal |
| `gemini-3.1-flash-lite` | Stable | Yes | 0.25 | 0.025 | 1.50 | not listed |
| `gemini-3.6-flash` | Stable | Yes | 0.75 → **1.50 from 2027-01-01** | 0.075 → 0.15 | 3.75 → **7.50** | medium |
| `gemini-3.8-flash` | Stable | Yes | 0.75 → **1.50 from 2027-01-01** | 0.075 → 0.15 | 3.75 → **7.50** | medium |
| `gemini-2.5-flash-lite` | Legacy (prior users only) | Yes | 0.10 | 0.01 | 0.40 | off |
| `gemini-2.5-flash` | Legacy (prior users only) | Yes | 0.30 | 0.03 | 2.50 | on |

- **Data use.** Google lists "Used to improve our products" as **Yes on the Free Tier and No on
  the Paid Tier** for these models. That is why live data is paid-only.
- **Excluded models.** `gemini-4-argon` (no free tier; $2/$10 rising to $4/$20 on 2026-12-01)
  and preview models are not approved. `gemini-3-pro-preview` and
  `gemini-3.1-flash-lite-preview` are already shut down.
- **API surface.** `generateContent` is still documented, with no deprecation date. Google's
  guides now label it **"Generate Content API (Legacy)"** and lead with the newer Interactions
  API. This adapter keeps the hardened `generateContent` path. A future move to Interactions is
  a separate change.
- **Structured output.** `responseMimeType: application/json` plus `responseJsonSchema`. Google
  ignores some keywords (`minLength`, `maxLength`, `uniqueItems`, …), and our Zod parse plus the
  semantic validators still enforce them. Very large or deeply nested schemas may return `400`.
  Mocks cannot prove the live API accepts every Tessaloom schema, so rollout step 3 checks that.
- **Service tier.** The default is Standard, and the adapter never requests Flex or Priority.
  Batch and Flex discounts are not used.
- **Price tiers by prompt length.** None of the approved models has one. The adapter caps inputs
  at 128 KiB, far below the 200k-token threshold some other models use.

## Recommendation

**`gemini-3.5-flash-lite`, paid tier, Standard.** It is stable, has a flat price with no
announced change, a free tier for development, defaults to minimal thinking (cheapest and most
predictable output), and supports structured output. Compared with Sonnet 5.5 ($2 / $10), it
is 6.7× cheaper on input and 4× cheaper on output.

If quality in the live probe is not good enough, try `gemini-3.8-flash` next. Budget for its
price doubling on 2027-01-01; the schedule already applies that automatically.

At Flash-Lite rates a single call reserves at most about $0.01–$0.04, depending on role (an R3
call with a 12k-token output cap is about $0.037). Settled costs are far lower. The existing
caps ($0.50/day for acceptance, $4/day for judging) are ample.

## Full-workflow support

All of the following were verified offline with synthetic Qloo data and mocked Gemini HTTP. The
tests use the real worker wiring and the PostgreSQL ledger
(`tests/integration/gemini-workflow.test.ts`).

- **Exploration.** Intent (R1), discovery, the collision pool, generation (R3), critique (R4) and
  revision, then selection to COMPLETED. Every call is reserved first, then settled to tokens ×
  published rates.
- **Blueprint composition (R6).** Runs to COMPLETED with every call settled.
- **What-if comparison narrative (R5).** A What-if branch is never attested as synthetic, so
  without live-data approval R5 is refused. The comparison then uses the deterministic template,
  with no request and no reservation. With approval, R5 runs on Gemini.
- **Run access.** `RUN_ACCESS=off` and invite-only access stop runs before any Gemini request or
  reservation.

**In production, the workflow is supported once `GEMINI_LIVE_DATA_APPROVED=on`.** Until then,
production runs fail their LLM steps with a configuration error (`DATA_SHARING_BLOCKED`), and
nothing is sent or spent.

## Exact production configuration (when every gate below is cleared)

These go in Northflank on the `tessaloom` service. The owner applies them. Nothing here is set
by this change.

| Variable | Value | Where |
| --- | --- | --- |
| `GEMINI_API_KEY` | key from the paid (billing-enabled) Google project | worker secret (runtime env); never a config group, never the web |
| `LLM_PROVIDER` | `gemini` | `tessaloom-llm-limits` group |
| `LLM_MODEL` | `gemini-3.5-flash-lite` | group |
| `LLM_FALLBACK_MODEL` | `gemini-3.5-flash-lite` (ignored: Gemini never falls back) | group |
| `LLM_MODE` | `standard` | group |
| `GEMINI_PAID_TIER_APPROVED` | `on` | group, set by the owner |
| `GEMINI_PRICING_VERIFIED_AT` | the owner's review time, e.g. `2026-10-28T09:00:00Z` (re-attest within 90 days) | group, set by the owner |
| `GEMINI_LIVE_DATA_APPROVED` | `on` **only after** Qloo data-processing permission is verified | group, set by the owner |
| `GEMINI_FREE_TIER_CONFIRMED` / `GEMINI_DATA_SHARING_APPROVED` | `off` | group |
| `GEMINI_MAX_REQUESTS` | `60` (acceptance) or `300` (judging): a per-UTC-day, per-process circuit breaker | group |
| `GEMINI_TIMEOUT_MS` | `60000` | group |
| Spend caps, run limits, `RUN_ACCESS` | **unchanged**: keep using the existing `llm-limits.*` values and `tessaloom-run-access` | as today |

[`deploy/northflank-groups/llm-limits.gemini-acceptance.json`](../deploy/northflank-groups/llm-limits.gemini-acceptance.json)
is a prepared, **unapplied** group with these values and the acceptance caps. Its approvals are
`off`, so applying it unchanged leaves the LLM unconfigured. For judging, copy the caps from
`llm-limits.judging.json`.

## Rollout plan (each step needs the owner's explicit go-ahead)

1. **Merge this PR.** Production behavior is unchanged, because the limits group still pins
   Anthropic and every Gemini gate defaults to off. If Northflank builds from `main`, merging
   redeploys the same configuration.
2. **Owner checks on Google's side (no code).**
   - Enable Cloud Billing on the key's project; this makes it Paid Tier.
   - Add a Cloud Billing budget with alerts. Alerts notify; they do not cap spending.
   - Confirm the region is supported and the model is available to the project.
   - Compare the pricing table above with Google's page and record the time as
     `GEMINI_PRICING_VERIFIED_AT`.
   - Keep the key in a private `0600` file, never in chat or the repository.
3. **One paid contract probe.** Needs explicit approval for one paid call, roughly $0.001. It
   makes one metadata GET and one synthetic generation, with zero retries and a private receipt:
   `LIVE_VALIDATION_APPROVED=yes LIVE_VALIDATION_PROVIDER=gemini LIVE_VALIDATION_RECEIPT=<abs path> GEMINI_PAID_TIER_APPROVED=on GEMINI_PRICING_VERIFIED_AT=<iso> LLM_MODEL=gemini-3.5-flash-lite pnpm test:live`
   (key loaded from the private file). It confirms the real `modelVersion` string (the adapter
   requires it to equal the model ID), the `usageMetadata` shape and `serviceTier`.
4. **Local synthetic end-to-end run.** Needs explicit approval and a dollar cap. Run with
   `APP_ENV=development`, `QLOO_MODE=synthetic`, `GLOBAL_DAILY_LLM_USD=0.25`, the paid Gemini
   settings, and `GEMINI_LIVE_DATA_APPROVED=off`. Drive one exploration and one blueprint. This
   proves Google accepts every Tessaloom response schema (or finds a `400` to fix first) and
   gives a real cost per run. Compare the ledger (`spend today`) with Cloud Billing the next day.
5. **Qloo data-processing permission.** This is a separate owner action. Confirm that Qloo-derived
   names, scores and evidence may be sent to Google's paid Gemini API. Record the evidence. Until
   then, stop here.
6. **Production canary.** Needs explicit approval.
   - Keep `RUN_ACCESS=off` while switching.
   - Add `GEMINI_API_KEY` to the worker. Keep `ANTHROPIC_API_KEY` for rollback.
   - Apply the Gemini acceptance group with the three approvals set, then restart.
   - Check that status shows Gemini configured, then set `RUN_ACCESS=invite`.
   - Run one granted run, then revoke the grant and set `RUN_ACCESS=off`.
   - Reconcile the ledger with Cloud Billing.
7. **Judging caps.** Use the judging values, `GEMINI_MAX_REQUESTS=300`, and re-attest pricing
   before the 90-day expiry.

## Rollback

- **Immediate stop.** Set `RUN_ACCESS=off` in `tessaloom-run-access` and restart. No new paid
  work is admitted.
- **Gemini only.** Set `GEMINI_MAX_REQUESTS=0` or `GEMINI_PAID_TIER_APPROVED=off` and restart.
  The worker reports the LLM as unconfigured, and nothing reaches Google.
- **Back to Anthropic.** Re-apply the previous group (`llm-limits.judging.json`,
  `llm-limits.acceptance.json` or `llm-limits.closed.json`), which pins `LLM_PROVIDER=anthropic`,
  then restart. Keep `ANTHROPIC_API_KEY` in place until Gemini has been stable for a judging
  period. Then remove `GEMINI_API_KEY` from the worker, and revoke the key in Google AI Studio if
  it is no longer used.
- **Code rollback (revert the merge).**
  1. First set `GEMINI_MAX_REQUESTS` to `0` (or at most 50). The previous schema rejects higher
     values and would stop the worker from starting.
  2. Switch the provider back to Anthropic.
  3. Then deploy the older image.

  Older code ignores the new variables.
- **Unknown or overrun billing.** A latched provider or the M10-A billing alarm pauses AI work.
  Reconcile with Cloud Billing before clearing it as the runbook describes. Never clear it by
  restarting alone.

## Known limits and follow-ups

- The real `modelVersion` value, the presence of `usageMetadata.serviceTier`, and whether the
  live API accepts every application schema are **unverified until rollout steps 3–4**.
- `llm_invocations.estimated_cost_usd` stores 4 decimals, so a single Flash-Lite call often
  shows `0.0000`–`0.0003`. The spend ledger keeps exact micro-dollars, and budgets use the ledger.
- `GEMINI_MAX_REQUESTS` is per worker process. It is a circuit breaker, not an account-wide rate
  limiter. Google's RPM/TPM/RPD limits for the project still apply, and `429` is not retried.
- Effort levels are not mapped to Gemini `thinkingLevel`. Each model uses its default, and
  thinking tokens are accounted either way.
