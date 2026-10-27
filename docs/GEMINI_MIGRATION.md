# Gemini API migration: Gemini 4 Argon and 3.8 Flash

Status on 2026-10-27: **implemented and tested offline only** (PR #26, not merged, not deployed).
No Gemini request has been made: no metadata call, no generation, no paid call. No real Qloo
data was used. Nothing in Northflank was changed (no secret, budget, `RUN_ACCESS` or deployment
setting).

**Nothing here is production-ready on the strength of mocked tests.** Each model's real
behavior is unverified until the paid acceptance below runs: the serving model ID, whether
Google accepts the schemas, token use, latency and cost.

**Production today has no working AI provider.** The rollout record of 2026-10-27 shows:
- `tessaloom-llm-limits` = the closed set, which selects Anthropic Claude Sonnet 5.5;
- **no `ANTHROPIC_API_KEY`**, so status reports `llmConfigured:false`;
- `RUN_ACCESS=off`, and every `*_LLM_USD` and `GLOBAL_DAILY_QLOO_CALLS` is `0`.

Anthropic is the selected name, not a functioning service or fallback. Until some provider
passes acceptance, rollback means **returning to that safe closed state**.

## 1. Gemini 4 Argon: what Google's documentation verifies (2026-10-27)

| # | Item | Verified | Source |
| --- | --- | --- | --- |
| 1 | Model ID and availability | `gemini-4-argon`, **Stable**, "Latest update: October 2026". No versioned or `-latest` alias is listed. **Availability to your specific project is not verifiable without a call**: it is checked by the free metadata GET in step 0 below. | [model page](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon) (updated 2026-10-14), [models](https://ai.google.dev/gemini-api/docs/models) |
| 2 | Paid Tier 1 and Standard pricing | "Not available on the Free tier." Paid Standard: **$2.00 input / $10.00 output (thinking included) per 1M tokens through 2026-11-30**. Implicit cache hits $0.10. No prompt-length tiers. Paid data is not used to improve products. | [pricing](https://ai.google.dev/gemini-api/docs/pricing) (updated 2026-10-26) |
| 3 | Scheduled price change | **Everything doubles on 2026-12-01**: $4.00 / $20.00 / cache $0.20. Encoded in `gemini-pricing.ts` and tested at the boundary. | pricing |
| 4 | Context limits | 1,048,576-token unified window. Output 65,536 by default; **32K per non-streaming request** (this adapter uses non-streaming REST, and the gateway ceiling is 32,000). | model page, [What's new in 4 Argon](https://ai.google.dev/gemini-api/docs/generate-content/latest-model) (updated 2026-10-16) |
| 5 | Thinking controls | `thinkingLevel` `low`/`medium`/`high`, default **medium**. `thinkingBudget` is deprecated, and sending both returns 400. Thinking tokens count toward `maxOutputTokens` and are billed as output. Sampling parameters and `candidate_count` are ignored. Explicit caching returns an error. | What's new, [thinking](https://ai.google.dev/gemini-api/docs/thinking) |
| 6 | Structured JSON | Structured outputs are supported. Google documents `responseMimeType` + `responseJsonSchema`, a keyword subset, and `400` for very large or deeply nested schemas. Tessaloom's six role schemas are normalized to that subset (see §4). Real acceptance is **unverified until the probe**. | model page, [structured output](https://ai.google.dev/gemini-api/docs/structured-output) |
| 7 | API surface | Both `generateContent` (labelled "Legacy", **no shutdown date**, with an Argon "What's new" page of its own) and the Interactions API. The adapter keeps `generateContent`. | What's new, [API reference](https://ai.google.dev/api/generate-content) |
| 8 | Response identifiers and usage | `modelVersion`, `responseId`. `usageMetadata` has prompt, cached, candidates, toolUsePrompt, thoughts, total and `serviceTier`. The exact `modelVersion` string for Argon is **unverified**; the adapter requires it to equal `gemini-4-argon`. | API reference |
| 9 | Tool use and thought tokens | No tools are sent. `toolUsePromptTokenCount` would be billed as input, and thoughts as output. Text-only multi-turn without thought signatures is "not an error", though quality may degrade; this affects our single repair turn. | API reference, [thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) (updated 2026-10-13) |
| 10 | Timeouts and rate limits | Google: "Set HTTP client timeouts to at least 20 minutes per call"; `high` is slowest to the first token. Paid Tier 1 = a linked active billing account, with a $250 billing cap. RPM/TPM are shown **only in AI Studio**. Tier 1 also has a **$10 per 10 minutes spend limit (429)**. Limits apply per project. | What's new, [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) |

**The timeout conflict.** Google's 20-minute timeout guidance cannot be followed here.
Tessaloom's real deadlines, all checked in code:

| Deadline | Value | Where | Effect when exceeded |
| --- | --- | --- | --- |
| Gemini request timeout | default 60 s; **maximum 120 s** (`GEMINI_TIMEOUT_MS`) | `packages/config/env.ts` | The request is aborted, reported as an unknown outcome, **never retried**, the reservation stays charged, and the run fails with `LLM_UNAVAILABLE` (a manual retry is the user's choice) |
| Attempts per step | up to 3: the first, one ×1.5 truncation retry, one repair | gateway | Up to 3 × 120 s = 360 s of provider time in one step |
| Queue job expiry | **600 s** (`RUN_STEP_EXPIRE_SECONDS`) | `packages/db/src/queue.ts` | The queue would re-run a step that is still in flight, a duplicate paid request. A unit test pins 3 × 120 s + 60 s < 600 s. |
| Run active wall clock | exploration **420 s**, What-if 180 s, blueprint 180 s, revalidation 240 s (time paused at user gates is excluded) | `DEFAULT_BUDGETS` | Checked **at the start of each step**, so an in-flight call is never cut off; the run stops with `BUDGET:wallClockSeconds` at the next step |

**What this means for Argon:**
- An exploration makes about 5 LLM calls (R1, R3, R4, R3 revise, R4) plus Qloo work inside
  420 s. Argon calls therefore need to average about **60–70 s or less**.
- A blueprint (one R6 call) has 180 s.
- `GEMINI_THINKING_LEVEL=low` is the only latency lever. Raising the 600 s queue expiry would
  need a queue migration, which is out of scope before the deadline.
- Latency is a pass/fail criterion of the paid acceptance.

## 2. Architecture comparison and recommendation

| | **A. Argon for every step** | **B. Hybrid: Argon for R3 and R6, 3.8 Flash for R1, R4, R5** | **C. 3.8 Flash for every step** |
| --- | --- | --- | --- |
| R1 brief interpretation, R4 evidence critique, R5 What-if narrative | Argon | 3.8 Flash | 3.8 Flash |
| R3 hypothesis generation and revision (the cross-domain bridges), R6 blueprint | Argon | Argon | 3.8 Flash |
| Discovery and evidence grading | Qloo plus deterministic code, never an LLM, in all designs | | |
| Implementation | **Done**: `LLM_MODEL=gemini-4-argon` | **Not built.** Needs per-role model routing in the gateway, run config, UI model label, reservations and tests. New code paths days before the deadline. | **Done**: `LLM_MODEL=gemini-3.8-flash` |
| Expected quality (unmeasured) | Highest reasoning model on every role, including the critique that grounds claims in evidence | Highest on the creative roles; standard on critique | Good; Google positions 3.8 Flash for agentic workflows |
| Correctness risk | Latency against the 120 s, 420 s and 600 s limits; truncation when medium thinking uses up a 4k–12k role cap (Google advises caps of at least 32,768) | Both models' risks combined, plus router bugs | Lowest; same code path as A |
| Expected cost per workflow (Nov 2026, §5) | ≈ $0.29 | ≈ $0.23 | ≈ $0.11 |
| Validation needed | Experiment A plus the E2E benchmark | Both experiments plus new router tests | Experiment B plus the E2E benchmark |

**Recommendation: a single, explicitly configured model. No router. B is deferred.** B's gain
over A is about 20% of cost, while it adds a new routing layer three days before the deadline.
R3 and R6 dominate cost anyway.

- **Primary candidate: A (Gemini 4 Argon, Standard, default thinking).** Judging (Nov 2–5)
  falls inside Argon's November pricing. It is adopted only if Experiment A and its E2E
  benchmark meet the criteria in §6.
- **Working target and alternative: C (Gemini 3.8 Flash).** This is the fallback the owner
  selects, by configuration, if Argon misses any criterion. It is also the cheaper choice after
  2026-12-01, when Argon's price doubles.
- **Baseline: `gemini-3.5-flash-lite`** (cheap checks only).

Nothing switches models automatically: no fallback model, no fallback provider.

## 3. What changed in code

| Area | Change |
| --- | --- |
| Model registry | `GEMINI_MODELS` adds `gemini-4-argon` (first), alongside 3.8/3.6 Flash, 3.5/3.1 Flash-Lite and legacy 2.5. `GEMINI_PAID_ONLY_MODELS` makes Argon refuse the free tier. |
| Pricing | `gemini-pricing.ts` holds a dated schedule: Argon doubles on 2026-12-01; 3.6/3.8 Flash double on 2027-01-01. The gateway snapshots rates once per call, so a reservation and its settlement use the same rates. Scheduled models are excluded from the clockless static `PRICES`, so they fail closed without the schedule. |
| Thinking | Optional `GEMINI_THINKING_LEVEL` (`low`/`medium`/`high`; unset = the model default, which is medium for Argon and 3.8). It is validated per model: Argon, 3.8/3.6 Flash and 3.5 Flash-Lite accept it; 2.5 and 3.1 refuse it. It is sent as `thinkingConfig.thinkingLevel`; `minimal` and `thinkingBudget` are never sent. The level is recorded with each invocation. |
| Request shape | Only `maxOutputTokens`, `responseMimeType`, `responseJsonSchema`, and the optional `thinkingConfig`. No `candidateCount`, sampling, tools, caching or service-tier upgrade. |
| Structured output | `geminiResponseSchema` inlines `$defs`/`$ref`; cyclic, missing or remote references fail before sending. Non-date formats move into the description. Zod and the semantic validators still enforce everything. |
| Accounting | Thinking tokens are billed as output and reported as `reasoningTokens`. Tool-use prompt tokens are billed as input. `totalTokenCount` is checked for consistency. A non-standard `serviceTier` is rejected. On the paid tier, accounting faults retain the reservation and latch further calls off. |
| **Duplicate paid requests** (defect fixed) | **Before:** a client timeout, dropped connection or unreadable response (any of which Google may still bill) became `UNAVAILABLE`, which the agent marked transient, so the queue **re-ran the step and resent the request up to twice**. **Now:** the gateway carries `retryable` and the step retries only when the provider says it is safe. That is an HTTP 429/5xx (Google does not charge 400/500 errors) or a request that was never sent. Gemini timeouts are non-retryable. Anthropic's own retry flags are unchanged. Manual retry from the UI remains a deliberate user action. |
| Timeout invariant | `RUN_STEP_EXPIRE_SECONDS` (600) is exported from the queue, and a unit test proves that Gemini's maximum timeout × 3 attempts plus a margin fits inside it. `GEMINI_TIMEOUT_MS` is capped at 120,000. |
| Templates (not applied) | `llm-limits.gemini-argon-acceptance.json`: Argon, $1.00 caps, 40 requests, 120 s timeout. `llm-limits.gemini-acceptance.json`: 3.8 Flash, $0.50 caps. All approvals are `off`; applied unchanged, either leaves the LLM unconfigured. |
| Unchanged | The M10-A ledger and every cap, `RUN_ACCESS`, run admission, per-run budgets, the Anthropic, DeepSeek and scripted providers, and the live Qloo path. |

## 4. Structured output and the role schemas

After normalization, the six schemas Tessaloom sends use only documented keywords; a unit test
covers each one.

| Role | Schema | Size sent |
| --- | --- | --- |
| R1 | IntentFrame | 2.2 KB |
| R3 | HypothesisBatch | 3.9 KB |
| R4 | CritiqueReport | 1.4 KB |
| R3 revise | HypothesisRevision (largest) | 8.1 KB |
| R5 | ComparisonNarrative | 0.7 KB |
| R6 | BlueprintDraft | 1.8 KB |

All are nested at most 4 levels deep. Google's possible `400` for large schemas is answered by
the paid probe and the E2E benchmark, not by mocks.

## 5. Cost analysis

**Method.** Real role output caps (`MAX_OUTPUT`): R1 4k, R3 12k, R4 6k, R5 2k, R6 8k tokens.
Request sizes were measured in the mocked workflow:

| R1 | R3 generate | R3 revise | R4 | R5 | R6 |
| --- | --- | --- | --- | --- | --- |
| 5.1 KB | 23.3 KB | ~30 KB (est.) | 12.5 KB | 4.9 KB | 7.6 KB |

- **Expected cost:** input at about 3.5 bytes per token; each call spends half its cap
  (thinking included).
- **Upper-bound reservation** (what the ledger holds before sending): every prompt byte counted
  as a token, plus 4,096, plus the **full output cap**.
- **Typical workflow:** an exploration with one revision round (R1, R3, R4, R3 revise, R4)
  plus one blueprint (R6). R5 runs only with live-data approval; otherwise the What-if
  narrative is a $0 template.

### Per call

| Role | Argon reservation (Nov / Dec) | Argon expected (Nov) | 3.8 Flash reservation (to Dec 31) | 3.8 Flash expected |
| --- | --- | --- | --- | --- |
| R1 | $0.058 / $0.117 | $0.023 | $0.022 | $0.009 |
| R3 generate | $0.175 / $0.350 | $0.073 | $0.066 | $0.028 |
| R3 truncation retry (18k) | $0.235 / $0.470 | — | $0.088 | — |
| R4 | $0.093 / $0.186 | $0.037 | $0.035 | $0.014 |
| R3 revise | $0.188 / $0.376 | $0.077 | $0.071 | $0.029 |
| R6 | $0.104 / $0.207 | $0.044 | $0.039 | $0.017 |
| R5 (live data only) | $0.038 / $0.076 | $0.013 | $0.014 | $0.005 |

### Per complete workflow (exploration + blueprint)

| Design | Expected (Nov) | All calls at full cap (Nov) | **Smallest experiment cap that finishes** (Nov) | Expected (from Dec 1; 3.8 from Jan 1) | Smallest cap that finishes (same) |
| --- | --- | --- | --- | --- | --- |
| A, Argon | **$0.29** | $0.53 | **$0.55** | $0.58 | $1.10 |
| B, hybrid | $0.23 | $0.42 | $0.44 | $0.43 | $0.81 |
| C, 3.8 Flash | **$0.11** | $0.20 | **$0.21** | $0.22 (Jan) | $0.41 (Jan) |

**Retries.** Each step may add one ×1.5 truncation retry and one repair, each reserved first.
If every step needed both, Argon would reach about $2.2 (Nov) before the limits bite. It
cannot reach that: the run budgets stop it first (exploration 14 calls / 60k output tokens /
$2.00, blueprint 3 calls / 20k / $0.70), and **the ledger's `EXPERIMENT_LLM_USD` is the hard
per-experiment ceiling**.

### Production acceptance and judging

- **One production acceptance run** (exploration + blueprint): Argon ≈ $0.29 expected, ≤ $1.00
  ledger cap; 3.8 Flash ≈ $0.11 expected, ≤ $0.50 cap.
- **Four judges, 3 workflows each** (12 workflows, Nov 2–5):
  - Argon: ≈ $3.5 expected, up to ≈ $6.4 if every call used its full cap.
  - 3.8 Flash: ≈ $1.3 expected, up to ≈ $2.4.
  - The existing judging caps ($4.00/day global, $1.00/day per workspace and per experiment)
    bound each day.
  - With Argon, a $1.00 judge code covers about 3 typical workflows but only one or two
    full-cap ones. With 3.8 Flash it always covers 3.

### Four separate protections

| Layer | What it is | Guarantee |
| --- | --- | --- |
| Expected cost | The estimates above | None; measured by the acceptance |
| Upper-bound reservation | Tessaloom's ledger: reserve before every request, settle to actual tokens × rates; unknown outcomes keep the full reservation | A local bound on what Tessaloom will send, not a provider guarantee |
| Provider-side actual cost | Google bills real tokens; 400/500 errors are not charged; a timed-out request may still be billed (our ledger keeps the reservation) | Visible in AI Studio / Cloud Billing, sometimes with delay |
| Account-wide protection | The $30 prepaid balance (requests fail with 429 once it is depleted), the Tier 1 $10 per 10 minutes spend limit (429), a Cloud Billing budget alert (notifies only), `RUN_ACCESS=off` | Independent of Tessaloom's code |

**The $30 prepaid balance is not a spending authorization.** Every paid step below names its
own small cap.

### Recommended caps (no live budget is increased; production stays at $0)

| Purpose | Global / workspace / experiment per day | Notes |
| --- | --- | --- |
| Argon acceptance ([template](../deploy/northflank-groups/llm-limits.gemini-argon-acceptance.json)) | **$1.00 / $1.00 / $1.00** | $0.50 cannot reliably finish an Argon workflow ($0.55 needed at full cap, Nov). A unit test proves $1.00 admits a full-cap workflow, even with conservative 32 KiB prompts. |
| 3.8 Flash acceptance ([template](../deploy/northflank-groups/llm-limits.gemini-acceptance.json)) | $0.50 / $0.50 / $0.50 | Fits even the largest single attempt the code allows at 2027 rates (unit-tested). |
| Judging (either model) | $4.00 / $1.00 / $1.00 (the existing judging set, unchanged) | Argon: about 13 typical workflows per day globally; after 2026-12-01 a full-cap Argon workflow needs about $1.10, above the $1.00 cap. |

## 6. Paid acceptance: prepared, **not executed**

Each step needs the owner's explicit approval of the exact experiment and its maximum. Run the
steps in order, and run each one once.

**Shared settings for every step:**
- Synthetic data only; `GEMINI_LIVE_DATA_APPROVED=off`.
- No production systems.
- The key lives only in `~/.config/tessaloom/gemini.env` (directory `0700`, file `0600`; the
  only line is `GEMINI_API_KEY=…`). It is loaded inside a subshell, so it never appears in
  command arguments, shell history or logs.
- The commands use the repo's own binaries (`pnpm test:live` is
  `vitest run --config vitest.live.config.ts`).

| Step | What | Paid requests | **Maximum** | Expected |
| --- | --- | --- | --- | --- |
| **Exp. A** | Argon contract probe: free metadata GET, then **one** generation on the real R1 prompt and IntentFrame schema, with an invented brief, default thinking, 4,000-token cap, zero retries | 1 | **$0.06** (one R1 reservation, Nov rates; $0.12 from Dec 1) | ≈ $0.02 |
| **Exp. B** | The same probe on `gemini-3.8-flash` | 1 | **$0.03** | ≈ $0.01 |
| **E2E-A** | One synthetic exploration + one blueprint on Argon through the real worker and DB ledger | ≤ 17 (run budgets) | **$1.00** (ledger caps) | ≈ $0.29 |
| **E2E-B** | The same brief on 3.8 Flash | ≤ 17 | **$0.50** | ≈ $0.11 |

**Total maximum: $1.59. Expected: about $0.43.** Neither the $30 prepaid balance nor Google's
limits are part of this authorization.

### Exp. A / Exp. B: contract probes

```bash
mkdir -p ~/.config/tessaloom/receipts && chmod 700 ~/.config/tessaloom ~/.config/tessaloom/receipts
```

```bash
( set -a; . ~/.config/tessaloom/gemini.env; set +a; LIVE_VALIDATION_APPROVED=yes LIVE_VALIDATION_PROVIDER=gemini LIVE_VALIDATION_RECEIPT="$HOME/.config/tessaloom/receipts/gemini-4-argon.json" GEMINI_PAID_TIER_APPROVED=on GEMINI_PRICING_VERIFIED_AT=2026-10-28T09:00:00Z LLM_MODEL=gemini-4-argon node_modules/.bin/vitest run --config vitest.live.config.ts )
```

For **Exp. B**, change two values: `LIVE_VALIDATION_RECEIPT=…/gemini-3.8-flash.json` and
`LLM_MODEL=gemini-3.8-flash`. Set `GEMINI_PRICING_VERIFIED_AT` to the time you actually
compared the prices.

**Stop conditions (probe):**
- The receipt file already exists: the probe refuses to run. Never delete a receipt to run again.
- After the run, `ok` is false, `modelId` differs from the model ID (the adapter would reject
  every production call), `latencyMs` > 90,000, `usage.outputTokens` reaches 4,000 (truncated),
  or the reason is `CONFIGURATION`/`INVALID_OUTPUT`.
- If any of these happen, **stop**: do not retry, and do not run E2E for that model.
- If you see any 429 (rate, spend or prepaid exhaustion): stop.

### E2E-A / E2E-B: synthetic benchmarks

This needs the release build (`pnpm build`) of this branch.

This path was dry-run on 2026-10-27 with a **dummy key and no run**:
- status `llmConfigured:true`, `llmModel:"gemini-4-argon"`;
- the web process received no Gemini variables;
- zero Gemini requests.

```bash
DATABASE_URL=postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom_e2e_gemini_argon node scripts/e2e-db.mjs
```

```bash
( set -a; . ~/.config/tessaloom/gemini.env; set +a; TL_ROLE=all NODE_ENV=production APP_ENV=test PORT=3210 HOSTNAME=127.0.0.1 TRUSTED_PROXY_HOPS=1 QLOO_MODE=synthetic RUN_ACCESS=open DATABASE_URL=postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom_e2e_gemini_argon SESSION_SECRET=local-benchmark-session-secret-0123456789 SHARE_TOKEN_PEPPER=local-benchmark-share-pepper-0123456789 LLM_PROVIDER=gemini LLM_MODEL=gemini-4-argon LLM_FALLBACK_MODEL=gemini-4-argon LLM_MODE=standard GEMINI_PAID_TIER_APPROVED=on GEMINI_PRICING_VERIFIED_AT=2026-10-28T09:00:00Z GEMINI_LIVE_DATA_APPROVED=off GEMINI_MAX_REQUESTS=17 GEMINI_TIMEOUT_MS=120000 GLOBAL_DAILY_LLM_USD=1.00 WORKSPACE_DAILY_LLM_USD=1.00 EXPERIMENT_LLM_USD=1.00 GLOBAL_DAILY_QLOO_CALLS=200 MAX_WORKING_RUNS=1 MAX_ACTIVE_RUNS_PER_WORKSPACE=1 WORKSPACE_DAILY_RUNS=2 node scripts/start.mjs )
```

For **E2E-B**:
- use database `tessaloom_e2e_gemini_flash` (in both commands);
- set `LLM_MODEL` and `LLM_FALLBACK_MODEL` to `gemini-3.8-flash`;
- set `GEMINI_TIMEOUT_MS=60000`;
- set all three `*_LLM_USD` to `0.50`.

The server listens on `127.0.0.1` only; `RUN_ACCESS=open` is therefore reachable only from this
Mac.

**Drive exactly one workflow** at <http://127.0.0.1:3210>, using the same invented brief for both
models:
- **Brief:** "Lantern Quay listening night"; a 40-seat cafe; interests "Neon Harbor Nights"
  (movie) and "Velvet Static Radio" (artist); low budget; 120 minutes.
- **Steps:** Interpret brief → Confirm & discover → confirm choices → tension 0.6 → Generate
  hypotheses → select the top hypothesis → Compose blueprint.
- **Then stop the stack** (Ctrl-C).

**Measure** (read-only):

```bash
docker exec tessaloom-postgres-1 psql -U tessaloom -d tessaloom_e2e_gemini_argon -c "SELECT prompt_id, model_id, validation_status, stop_reason, input_tokens, cached_input_tokens, output_tokens, input_excerpt->>'reasoningTokens' AS thinking_tokens, latency_ms, estimated_cost_usd FROM llm_invocations ORDER BY created_at, id;" -c "SELECT model, status, count(*) AS attempts, sum(reserved_micros)/1e6 AS reserved_usd, sum(actual_micros)/1e6 AS settled_usd FROM llm_spend_reservations GROUP BY model, status ORDER BY status;"
```

The next day, compare the settled total with AI Studio usage.

**Stop conditions (E2E). Stop the stack immediately, and never retry or restart to continue,
when any of these happens:**
- A run ends `FAILED` or `BUDGET:*`.
- An invocation is `TRUNCATED`, or is still `INVALID` after its one repair.
- A call's `latency_ms` exceeds 90,000.
- `model_id` differs from the configured model.
- Any `UNKNOWN` reservation appears (a possibly billed timeout or accounting fault).
- Settled spend passes **$0.60 (Argon) or $0.25 (3.8 Flash)**, about twice the expected cost,
  before the blueprint finishes.
- Any 429.

Start a second workflow only with a new approval.

**Pass criteria to adopt Argon (Design A):**

| Criterion | Requirement |
| --- | --- |
| Serving model | `modelId` is exactly `gemini-4-argon` |
| Schemas | All roles accepted. No `400`; at most one repair in the workflow. |
| Truncation | No `TRUNCATED` outcome at the default caps |
| Latency | Every call ≤ 90 s; exploration active time ≤ 300 s of its 420 s; R6 ≤ 120 s |
| Cost | Measured cost within the §5 estimates; settled ledger matches AI Studio |
| Quality | Owner review against 3.8 Flash on the same brief: bridge originality, claim/evidence grounding, critique accuracy, blueprint usefulness |

If Argon misses only latency or truncation, the one allowed variation is re-running E2E-A once
with `GEMINI_THINKING_LEVEL=low`. That needs a new approval (maximum $1.00). Otherwise choose
C (3.8 Flash).

## 7. Two separate Qloo permissions

| | Showing Qloo-derived results publicly | Sending Qloo-derived data to Google's paid Gemini API |
| --- | --- | --- |
| Covers | Rendering names, bridges and evidence summaries in the hosted app; saved samples and shared stories; storing normalized facts | The worker sending resolved names, IDs, descriptions, scores, claims and evidence to `generativelanguage.googleapis.com` |
| Source | The hackathon kit asks to present results "with their source and limits" and to "cache only what your project needs". Storage, replay and redistribution are **pending** ([R-08](DECISIONS.md)). | Qloo's API terms or a written organizer answer. The kit is silent on third-party model providers. **No written answer has been received, and silence is not permission.** |
| Control | `QLOO_RAW_RETENTION=off`, the fixture firewall, provenance labels | `GEMINI_LIVE_DATA_APPROVED` (default `off`, paid only) |
| Now | Partially addressed; R-08 open | **Not authorized. The gate stays closed.** |

**With the gate closed, production Gemini sends nothing:**
- Production runs always use live Qloo data, so every LLM step fails safely with
  `DATA_SHARING_BLOCKED` before any reservation.
- What-if branches fall back to the template narrative.

Paid-tier data terms are not Qloo's permission.

## 8. How judges use Tessaloom

The owner verified the official rules on 2026-10-20 and 2026-10-26; the live page blocks
automated reading. They require:
- a **functional, publicly accessible demo**;
- free judge access "without any restriction" through judging (Nov 2–5);
- **no mandatory video**.

**A recording does not substitute for a working agent.**

1. **Read a saved story** (no code). This needs display permission for that real-data sample.
2. **Run the agent with a private access code.** Brief → entity choices → discovery → bridges
   → hypotheses with evidence → blueprint (→ What-if). This needs, in production:
   - a provider that passed acceptance, with its key installed;
   - open budgets and `RUN_ACCESS=invite`, plus judge codes;
   - **for Gemini, `GEMINI_LIVE_DATA_APPROVED=on`**, because judge runs use live Qloo data.
3. **Local reproduction** (synthetic data, scripted AI). This supplements step 2 but does not
   replace it.

Today none of step 2's prerequisites hold, so **judges cannot run the agent** until the
blockers in §11 clear.

## 9. Production configuration (only after every blocker clears)

The owner applies this in Northflank on service `tessaloom`; this change sets nothing.

| Variable | Design A (Argon) | Design C (3.8 Flash) |
| --- | --- | --- |
| `GEMINI_API_KEY` | worker runtime secret only (never a group, never the web) | same |
| `LLM_PROVIDER` | `gemini` | `gemini` |
| `LLM_MODEL` = `LLM_FALLBACK_MODEL` | `gemini-4-argon` | `gemini-3.8-flash` |
| `GEMINI_PAID_TIER_APPROVED` | `on` | `on` |
| `GEMINI_PRICING_VERIFIED_AT` | the owner's review time. Re-attest **before 2026-12-01** (Argon doubles) and every 90 days | re-attest before 2027-01-01 |
| `GEMINI_LIVE_DATA_APPROVED` | `on` only after written transmission permission | same |
| `GEMINI_THINKING_LEVEL` | unset (medium), or `low` if acceptance requires it | unset |
| `GEMINI_TIMEOUT_MS` | `120000` | `60000` |
| `GEMINI_MAX_REQUESTS` | `40` acceptance, `300` judging | `60` / `300` |
| Caps | the Argon acceptance template, then the judging set | the 3.8 template, then the judging set |
| `RUN_ACCESS` | `off` while switching, `invite` for judging | same |

## 10. Rollout and rollback

**Rollout.** Each step needs explicit approval.

1. **Merge PR #26.** Production is unchanged: it stays closed, keyless and $0, with every Gemini
   gate off. If Northflank builds from `main`, merging redeploys this same safe state.
2. Run §6 steps 0, A, B, E2E-A, E2E-B, and choose A or C against the criteria.
3. **Obtain written permission to send Qloo-derived data to Google.** Stop here without it.
4. **Production canary.**
   - Keep `RUN_ACCESS=off`.
   - Add `GEMINI_API_KEY`, apply the chosen acceptance template with the approvals set, and
     restart.
   - Check that status shows `llmConfigured:true` with the chosen model.
   - Set `RUN_ACCESS=invite`, run one granted live run, then revoke the grant and set
     `RUN_ACCESS=off`.
   - Reconcile the ledger with AI Studio.
5. Apply the judging caps, create the codes, and update the Devpost testing text to name the
   provider.

**Rollback.** Each path is covered by `tests/unit/northflank-groups.test.ts`.

- **Immediate stop.** Set `RUN_ACCESS=off` (`tessaloom-run-access`) and restart.
- **Gemini only.** Set `GEMINI_MAX_REQUESTS=0` or `GEMINI_PAID_TIER_APPROVED=off` and restart.
  The LLM becomes unconfigured, and nothing reaches Google.
- **Back to the safe closed state.** Re-apply `llm-limits.closed.json` ($0, Anthropic selected
  without a key, so the LLM is unconfigured) and restart. This is **not** a working fallback
  provider. A working Anthropic path exists only if a key is installed and passes its own
  acceptance. Remove `GEMINI_API_KEY`, and revoke it in AI Studio if unused.
- **Code rollback.**
  1. Set `GEMINI_MAX_REQUESTS` ≤ 50 and remove `GEMINI_THINKING_LEVEL`. The old schema rejects
     larger values but ignores unknown variables.
  2. Return to the closed set.
  3. Re-pin the previous image.
- **Unknown or overrun billing.** The latch or billing alarm pauses AI work. Reconcile with
  Cloud Billing before clearing it; never clear it by restarting alone.

## 11. Exact remaining blockers

1. **Written permission to send Qloo-derived data to Google's paid Gemini API.** This is
   external (the organizer has not replied). Without it, production Gemini cannot run a single
   live step.
2. **The owner's approval of §6 (≤ $1.59).** Until it runs, the following are unverified: Argon
   availability to this project, the exact `modelVersion`, live acceptance of the six schemas,
   latency against the 120 s, 420 s and 600 s limits, truncation at the default caps, and real
   token use and cost.
3. **A model decision** (A or C) from the §6 evidence.
4. **Production setup by the owner:** key, chosen template with approvals, canary approval,
   judge codes, `RUN_ACCESS=invite`, and Devpost testing text.
5. **The display permission (R-08)** for any public real-data sample or media.
6. **Deadline:** submission Oct 30, 23:45 ET.

## Known limits

- `llm_invocations.estimated_cost_usd` stores 4 decimals; the ledger keeps exact micro-dollars.
- `GEMINI_MAX_REQUESTS` is a per-process circuit breaker, not an account-wide limiter. Google's
  per-project limits, including the Tier 1 $10 per 10 minutes spend limit, still apply.
- The repair turn sends prior output as plain text, without a thought signature. Google calls
  this valid for text-only requests, though quality may degrade.
- Role effort is not mapped to `thinkingLevel`; one explicit level, or the model default,
  applies to all roles.
