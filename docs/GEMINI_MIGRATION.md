# Gemini API migration: paid-capable provider, rollout and rollback

Status on 2026-10-27: **implemented and tested offline only** (PR #26, not merged, not deployed).
No Gemini request (metadata or generation) has been made. No paid call, real Qloo data,
Northflank change, secret, budget or `RUN_ACCESS` change was made.

**Production today has no working AI provider.** The rollout record of 2026-10-27 shows:
- `tessaloom-llm-limits` = the closed set, which selects Anthropic Claude Sonnet 5.5.
- **No `ANTHROPIC_API_KEY`** (`ANTHROPIC_names=0`), so status reports `llmConfigured:false`.
- `RUN_ACCESS=off`, and every `*_LLM_USD` is `0`.

"Anthropic" is therefore only the selected provider name, not a functioning service or a
fallback. Production gets a working agent only when the owner installs a provider key and
opens budgets and access.

## Recommendation

**Production: `gemini-3.8-flash` on the paid tier, Standard service.** Quality comes first. It
is Google's current stable Flash model for agentic and enterprise workflows:
- 1,048,576 input tokens and 65,536 output tokens;
- structured outputs;
- default thinking level `medium`.

**Optional low-cost baseline: `gemini-3.5-flash-lite`.** It is stable, at $0.30 / $2.50, with
minimal thinking by default. Use it for cheap synthetic checks or as a deliberate cost
fallback chosen by the owner. It is not the production default.

Both stay in the approved list; nothing switches between them automatically.

## What changed

| Area | Change |
| --- | --- |
| Billing tiers | `GeminiProvider` accepts exactly one tier. **Free** needs `GEMINI_FREE_TIER_CONFIRMED` plus `GEMINI_DATA_SHARING_APPROVED`, settles at $0, allows at most 50 requests per worker lifetime, and is refused in production. **Paid** needs `GEMINI_PAID_TIER_APPROVED=on` plus `GEMINI_PRICING_VERIFIED_AT`, settles actual cost at published rates, and allows up to 5,000 requests per UTC day per worker process. |
| Pricing review | `GEMINI_PRICING_VERIFIED_AT` is the owner's dated check of the price table. It must be on or after `GEMINI_PRICE_REVIEW` (2026-10-26), not in the future, and at most 90 days old. Once it expires, paid calls pause **without sending**. |
| Live data gate | `GEMINI_LIVE_DATA_APPROVED` (paid only, default `off`). Without it, the gateway refuses every input not attested as synthetic, before any reservation, recording or request. See "Two separate Qloo permissions" below. |
| Pricing | `providers/gemini-pricing.ts` holds a dated schedule, including the **3.6/3.8 Flash doubling on 2027-01-01**. The worker passes `geminiPrices`, and the gateway snapshots rates once per `generate()` call. Scheduled-price models are excluded from the clockless static `PRICES`, so a gateway without the schedule fails closed (`UNPRICED_MODEL`). |
| Request shape | `generationConfig` carries only `maxOutputTokens`, `responseMimeType: application/json` and `responseJsonSchema`. There is **no `candidateCount`** ("unsupported in Gemini 3 and later"), no sampling parameters, and no thinking override (3.8 Flash rejects `minimal`). Each model keeps its documented default thinking level. No tools, and no service-tier upgrade. |
| Structured-output schema | `geminiResponseSchema` inlines local `$defs`/`$ref`. A cyclic, missing or remote reference fails closed before sending. Formats other than `date-time`/`date`/`time` (Tessaloom uses `uuid`) move into the description. The gateway's Zod parse and semantic validators still enforce every constraint. |
| Accounting | `toolUsePromptTokenCount` is billed as input. Thinking tokens are billed as output and reported as `reasoningTokens`. `totalTokenCount` must equal prompt + tool-use prompt + thoughts + candidates. A response served on any `serviceTier` other than standard is rejected. |
| Paid accounting latch | An invalid envelope, inconsistent usage, a non-standard tier or an unexpected serving model keeps the full reservation charged. It also latches further Gemini calls off until restart. |
| Models | Approved: `gemini-3.8-flash` (recommended), `gemini-3.6-flash`, `gemini-3.5-flash-lite` (baseline), `gemini-3.1-flash-lite`, and legacy 2.5 Flash / Flash-Lite. Previews are excluded. There is no automatic selection and no fallback model or provider. |
| Production guards | The worker environment rejects: the free tier in production; both tiers at once; paid without a pricing date; live data without paid; more than 50 free-tier requests. The Claude subscription provider remains refused outside development and test. |
| Unchanged | The M10-A spend ledger: per-attempt reservations, global, workspace, experiment, run and grant caps, the billing alarm, `RUN_ACCESS` (`off` = kill switch), run admission, per-run call and token budgets. Also the Anthropic, DeepSeek and scripted providers, and the live Qloo integration. |

## Verified against Google's documentation (2026-10-27)

Sources:
- [models](https://ai.google.dev/gemini-api/docs/models) (updated 2026-10-22)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [What's new in 3.8 Flash](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8)
- [pricing](https://ai.google.dev/gemini-api/docs/pricing) (updated 2026-10-26)
- [generateContent reference](https://ai.google.dev/api/generate-content)
- [structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [thinking](https://ai.google.dev/gemini-api/docs/thinking)
- [Gemini 3 guide](https://ai.google.dev/gemini-api/docs/generate-content/gemini-3)
- [service tiers](https://ai.google.dev/gemini-api/docs/optimization)

Paid Tier, Standard, text, USD per 1M tokens (output includes thinking):

| Model | Status | Input | Cached input | Output | Default thinking |
| --- | --- | --- | --- | --- | --- |
| **`gemini-3.8-flash`** | Stable | 0.75 → **1.50 from 2027-01-01** | 0.075 → 0.15 | 3.75 → **7.50** | medium (`low`/`medium`/`high`; `minimal` errors) |
| `gemini-3.6-flash` | Stable | 0.75 → 1.50 from 2027-01-01 | 0.075 → 0.15 | 3.75 → 7.50 | medium |
| `gemini-3.5-flash-lite` | Stable | 0.30 | 0.03 | 2.50 | minimal |
| `gemini-3.1-flash-lite` | Stable | 0.25 | 0.025 | 1.50 | not listed |
| `gemini-2.5-flash` / `-lite` | Legacy (prior users only) | 0.30 / 0.10 | 0.03 / 0.01 | 2.50 / 0.40 | on / off |

**3.8 Flash specifics that the adapter now respects:**

| Item | What Google documents | What the adapter does |
| --- | --- | --- |
| Unsupported request fields | `candidate_count` is "unsupported in Gemini 3 and later"; sampling parameters are deprecated. | No `candidateCount`, temperature, topP or topK. The response is still required to contain at most one candidate. |
| Thinking | `minimal` returns an error; thinking tokens count toward the output limit and are billed as output. | No thinking override is sent. Thinking tokens are accounted and limited by each role's cap. |
| Structured output | `responseMimeType` + `responseJsonSchema`. Google ignores some keywords (`minLength`, `maxLength`, …), and large or deeply nested schemas may return `400`. | The six role schemas are 0.7–8.1 KB after inlining (`HypothesisRevision` is largest), depth ≤4. A unit test confirms each one uses documented keywords only. |
| Multi-turn | Thought signatures are not strictly enforced for text-only conversations; omitting them may reduce quality. Prefilled final model turns are not supported. | The one repair turn sends the prior output as plain text, and the last turn is always the user's. |
| Service tier | Standard is the default; Flex and Priority exist and cost differently. | The adapter never requests another tier and rejects any response that reports one. |

**What this doesn't settle:** `generateContent` is labelled "Legacy" in Google's guides and has
no shutdown date; the newer Interactions API is a separate future change. **Mocks cannot prove
that the live API accepts every Tessaloom schema**, the exact `modelVersion` string, or how
often medium thinking hits the output caps. Rollout steps 3–4 measure these.

**Data use:** Google lists "Used to improve our products" as **Yes on the Free Tier and No on
the Paid Tier**.

## Cost per workflow on `gemini-3.8-flash`

All figures are from the mocked workflow. Request sizes were measured per role:

| Role | Request bytes | Output cap (tokens) |
| --- | --- | --- |
| R1 intent | 5.1 KB | 4,000 |
| R3 generate | 23.3 KB | 12,000 |
| R4 critique | 12.5 KB | 6,000 |
| R5 What-if | 4.9 KB | 2,000 |
| R6 blueprint | 7.6 KB | 8,000 |

**Largest single reservation** (prompt bytes + 4,096 counted as tokens, plus the full output
cap):

| | R1 | R3 | R3 truncation retry (18k) | R4 | R5 | R6 |
| --- | --- | --- | --- | --- | --- | --- |
| to 2026-12-31 | $0.022 | $0.066 | **$0.088** | $0.035 | $0.014 | $0.039 |
| from 2027-01-01 | $0.044 | $0.131 | **$0.176** | $0.070 | $0.029 | $0.078 |

The absolute ceiling a single attempt can reserve is **$0.443 at 2027 rates**: a 128 KiB request
with the 32k-token output ceiling. A unit test confirms it fits inside every acceptance and
judging cap.

**Expected billed cost per full workflow:**
- **Typical:** exploration (R1, R3, R4, R3 revise, R4), one blueprint, one What-if. This assumes
  about 3.5 bytes per token and each call using about half its output cap, thinking included.
- **Worst case:** bounded by the default run budgets (exploration 14 calls / 60k output tokens,
  composition 20k, What-if 15k).

| | Exploration | Blueprint | What-if | **Full workflow** | Worst case |
| --- | --- | --- | --- | --- | --- |
| to 2026-12-31 | $0.093 | $0.017 | $0.005 | **≈ $0.11** | ≈ $0.45 |
| from 2027-01-01 | $0.186 | $0.033 | $0.010 | **≈ $0.23** | ≈ $0.89 |

For comparison, the `gemini-3.5-flash-lite` baseline is roughly half the typical cost or less.

These are estimates until rollout step 4 measures real token counts. Whatever happens, the
ledger caps each experiment at `EXPERIMENT_LLM_USD`.

### Recommended caps (no live budget is increased)

| Set | Global / workspace / experiment per day | Runs | `GEMINI_MAX_REQUESTS` | Why |
| --- | --- | --- | --- | --- |
| Acceptance ([prepared group](../deploy/northflank-groups/llm-limits.gemini-acceptance.json)) | **$0.50 / $0.50 / $0.50** (unchanged) | 1 working, 2/day | 60 | Covers one typical workflow (≈ $0.11–0.23) and the largest possible single attempt. A pathological 2027 worst case would stop at the experiment cap, failing closed. |
| Judging | **$4.00 / $1.00 / $1.00** (the existing `llm-limits.judging.json` values, unchanged) | 2 working, 6/day | 300 | About 17–35 typical workflows per day globally. $1.00 per workspace or experiment covers one worst-case workflow even at 2027 rates (≈ $0.89). 300 requests is at least 14 worst-case workflows (about 21 calls each). |
| Judge codes | The existing plan's per-code USD cap of $1.00 | 3 workflows per code | — | Three typical workflows cost ≈ $0.34–0.69. |

## Two separate Qloo permissions

These are different questions, and neither answers the other.

| | Showing Qloo results to the public and judges | Sending Qloo-derived data to Google's paid Gemini API |
| --- | --- | --- |
| What it covers | Rendering entity names, bridges and evidence summaries in the hosted app; saved and replayed samples and shared stories; storing normalized facts. | The worker transmitting resolved entity names, IDs, claims and evidence summaries to `generativelanguage.googleapis.com` for each R1–R6 call. |
| Governing source | The Qloo hackathon kit asks projects to present results "with their source and limits" and to cache "only what your project needs". Storage, replay and redistribution rights are **pending** ([R-08](DECISIONS.md)). | Qloo's API terms or the organizers. The kit is silent on third-party model providers, and the repo records **no authorization**. Earlier owner notes denied sharing with free-tier Gemini and required explicit permission for DeepSeek. |
| Control in code | `QLOO_RAW_RETENTION=off`, the fixture firewall, sample provenance labels. | `GEMINI_LIVE_DATA_APPROVED` (default `off`, paid only). |
| Current state | Partially addressed (no raw retention; labelled provenance); R-08 unresolved. | **Not authorized. The gate stays closed.** |

Display permission must never be read as permission to transmit, and paid-tier data terms are
not Qloo's permission either. Set `GEMINI_LIVE_DATA_APPROVED=on` only after **explicit, recorded
authorization** to send Qloo-derived data to Google's paid API. Record its source and date next
to the rollout record.

## How judges actually use Tessaloom

The official rules, as verified by the owner on 2026-10-20 and re-read 2026-10-26, say:
- a **functional, publicly accessible demo link** is required;
- judges must be able to test it **free "without any restriction"** through judging (Nov 2–5);
- a video is **not** mandatory.

The live rules page blocks automated reading (a Cloudflare challenge), so these points come
from the owner's verification in [HACKATHON_CHECKLIST.md](HACKATHON_CHECKLIST.md) §1.1 and
[M11_HOSTING.md](M11_HOSTING.md). **A recorded video does not substitute for a working agent**:
it can only supplement a demo that runs.

The judge journey planned in [DEVPOST.md](submission/DEVPOST.md) "Testing instructions":

1. **Read a finished experiment (no code, no cost).** The public URL → Demo samples → a saved
   real-data story. This needs the display permission (R-08) for that sample, and a saved
   real-data run to exist.
2. **Run the agent yourself (access code).** The judge opens **Unlock AI runs** and enters a
   private, expiring, capped code. They then create a project, write a brief, confirm entities,
   generate hypotheses, inspect evidence, and compose a blueprint. **This is the "working
   agent".** It needs, in production:
   - a working provider key with an open budget;
   - `RUN_ACCESS=invite`;
   - judge grants;
   - with Gemini, `GEMINI_LIVE_DATA_APPROVED=on`, because every judge run uses live Qloo data.
3. **Reproduce locally** (synthetic data, scripted AI). This is a supplement and does not
   satisfy step 2.

Today none of step 2's prerequisites hold. Production has no key, `RUN_ACCESS=off` and $0
budgets, and the Gemini live-data gate is closed. **Until an AI provider is live in production,
judges cannot run the agent.** The DEVPOST "fallback testing text" says so itself: it "does not
fully meet the rule".

## Exact production configuration (once every blocker is cleared)

Applied by the owner in Northflank on the `tessaloom` service. Nothing here is set by this
change.

| Variable | Value | Where |
| --- | --- | --- |
| `GEMINI_API_KEY` | key from the billing-enabled Google project | worker secret (runtime env); never a config group, never the web |
| `LLM_PROVIDER` | `gemini` | `tessaloom-llm-limits` group |
| `LLM_MODEL` / `LLM_FALLBACK_MODEL` | `gemini-3.8-flash` / `gemini-3.8-flash` (the fallback is ignored; Gemini never falls back) | group |
| `LLM_MODE` | `standard` | group |
| `GEMINI_PAID_TIER_APPROVED` | `on` | group, set by the owner |
| `GEMINI_PRICING_VERIFIED_AT` | the owner's review time, e.g. `2026-10-28T09:00:00Z` (re-attest within 90 days, and again after the 2027-01-01 price change) | group, set by the owner |
| `GEMINI_LIVE_DATA_APPROVED` | `on` **only after** the transmission authorization above | group, set by the owner |
| `GEMINI_FREE_TIER_CONFIRMED` / `GEMINI_DATA_SHARING_APPROVED` | `off` | group |
| `GEMINI_MAX_REQUESTS` | `60` (acceptance) or `300` (judging) | group |
| `GEMINI_TIMEOUT_MS` | `60000` | group |
| Spend caps, run limits | the existing acceptance or judging values (table above) | group |
| `RUN_ACCESS` | `off` while switching, `invite` for judging | `tessaloom-run-access` |

[`deploy/northflank-groups/llm-limits.gemini-acceptance.json`](../deploy/northflank-groups/llm-limits.gemini-acceptance.json)
is prepared and **unapplied**: 3.8 Flash, acceptance caps, approvals `off`. Applied unchanged, it
leaves the LLM unconfigured (unit-tested). For judging, copy the caps from
`llm-limits.judging.json`.

## Rollout plan (each step needs the owner's explicit go-ahead)

1. **Merge PR #26.** This changes nothing in production: the limits group still selects
   Anthropic, there is no key, and the Gemini gates are off. If Northflank builds from `main`,
   merging redeploys the same configuration.
2. **Google-side setup by the owner (no code).**
   - Enable Cloud Billing on the key's project; this makes it Paid Tier.
   - Add a Cloud Billing budget with alerts. Alerts notify; they do not cap spending.
   - Confirm the region is supported and `gemini-3.8-flash` is available to the project.
   - Compare the pricing table above with Google's page and record `GEMINI_PRICING_VERIFIED_AT`.
   - Keep the key in a private `0600` file.
3. **One paid contract probe** (approval for one call, about $0.01). One metadata GET and one
   synthetic generation, with zero retries and a private receipt:
   `LIVE_VALIDATION_APPROVED=yes LIVE_VALIDATION_PROVIDER=gemini LIVE_VALIDATION_RECEIPT=<abs path> GEMINI_PAID_TIER_APPROVED=on GEMINI_PRICING_VERIFIED_AT=<iso> LLM_MODEL=gemini-3.8-flash pnpm test:live`.
   It confirms the real `modelVersion` (which must equal the model ID), the `usageMetadata`
   shape and `serviceTier`.
4. **Local synthetic end-to-end run** (approval with a $0.50 cap).
   - Settings: `APP_ENV=development`, `QLOO_MODE=synthetic`, `GLOBAL_DAILY_LLM_USD=0.50`, paid
     Gemini, `GEMINI_LIVE_DATA_APPROVED=off`.
   - Run one exploration, one blueprint and one What-if (which uses the template narrative,
     since the gate is closed).
   - This proves Google accepts every schema.
   - It measures real tokens, thinking, truncations and cost per role. It compares quality
     against the 3.5 Flash-Lite baseline if wanted.
   - Reconcile the ledger with Cloud Billing.
5. **Qloo transmission authorization** (explicit and recorded; separate from display rights).
   Stop here until it is given.
6. **Production canary** (approval).
   - Keep `RUN_ACCESS=off` while switching.
   - Add `GEMINI_API_KEY` to the worker.
   - Apply the Gemini acceptance group with the three approvals set, then restart.
   - Check that status shows `llmConfigured:true` with `gemini-3.8-flash`.
   - Set `RUN_ACCESS=invite`, run one granted run, then revoke the grant and set
     `RUN_ACCESS=off`.
   - Reconcile with Cloud Billing.
7. **Judging.** Apply the judging caps and `GEMINI_MAX_REQUESTS=300`, create the judge codes,
   and update the Devpost testing text to name Gemini.

## Rollback

All rollback paths are covered by `tests/unit/northflank-groups.test.ts`.

- **Immediate stop.** Set `RUN_ACCESS=off` in `tessaloom-run-access` and restart.
- **Gemini only.** Set `GEMINI_MAX_REQUESTS=0` or `GEMINI_PAID_TIER_APPROVED=off` and restart.
  The LLM becomes unconfigured, and nothing reaches Google.
- **Return to the pre-Gemini state.** Re-apply `llm-limits.closed.json` (or the
  acceptance/judging set) and restart. This selects Anthropic, but **without an
  `ANTHROPIC_API_KEY` it is not a working fallback**: the LLM is unconfigured and runs fail
  safely with `LLM_NOT_CONFIGURED`. A working Anthropic fallback exists only if the owner
  separately installs an Anthropic key and opens budgets. Remove `GEMINI_API_KEY` from the
  worker, and revoke it in Google AI Studio if unused.
- **Code rollback (revert the merge).**
  1. Set `GEMINI_MAX_REQUESTS` to `0` (or at most 50) first. The previous schema rejects higher
     values and the worker would not start.
  2. Return to the closed set.
  3. Then deploy the older image.

  Older code ignores the new variables.
- **Unknown or overrun billing.** A latched provider or the M10-A billing alarm pauses AI work.
  Reconcile with Cloud Billing before clearing it as the runbook describes; never clear it by
  restarting alone.

## Known limits

- These remain **unverified until rollout steps 3–4**: the live `modelVersion` value, the
  `serviceTier` field, live acceptance of every schema, real token use, and how often medium
  thinking reaches the R1 (4k) and R5 (2k) output caps. Hitting a cap triggers one ×1.5
  truncation retry, which is reserved first.
- `llm_invocations.estimated_cost_usd` stores 4 decimals. The ledger keeps exact micro-dollars,
  and budgets use the ledger.
- `GEMINI_MAX_REQUESTS` is per worker process: a circuit breaker, not an account-wide limiter.
  Google's project RPM/TPM/RPD limits still apply, and `429` is not retried.
- Role effort is not mapped to `thinkingLevel`; every model uses its default.
