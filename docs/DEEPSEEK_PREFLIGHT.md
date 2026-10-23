# DeepSeek synthetic quality test — final preflight

Verified: **2026-10-23, 19:44 Asia/Shanghai**. Existing checkpoint remains **6e210c283e81d850c7dad6bc53139f86930c43b2**, on `codex/live-provider-validation`. These preflight additions do not amend that commit.

**Historical status at the time of this preflight: offline checks passed; only the plan had been approved. The owner subsequently authorized execution, and the two-call results are recorded in [the live trial report](DEEPSEEK_LIVE_TRIAL_2026-10-23.md).** No DeepSeek/Qloo API requests, account purchases, recharge, pushes, merges or deployment occurred. The local Docker check was a disposable offline verification, not a deployment.

This two-call plan supersedes the earlier four-call proposal in `LIVE_PROVIDER_VALIDATION.md` for the first trial.

## Interrupted approval investigation

The previous actual-credential isolation command was not executed because automatic approval review could not complete while the Codex usage limit was reached. The tool explicitly identified a review-service failure, not an unsafe-action determination. The subsequent database command in the same orchestration was not reached either.

After resuming, the account-status tool reported ordinary usage allowed and no reached limit. The same isolation command was submitted again through the normal elevated-action approval mechanism and succeeded. No permission settings were changed, no reset/credits were consumed or purchased, and no sandbox restriction was bypassed. Earlier sentinel-only startup diagnostics also caught a permission-order bug in this new verification helper: chmod must occur while the directory is root-owned, before chown to the worker. The helper was fixed without adding capabilities, then passed with a sentinel and finally with the real key.

## Credential and execution isolation

`tests/security/deepseek-isolation-preflight.mjs` verified the actual private key, without displaying it, using immutable local image:

`sha256:27e84debd59a68d27b9cb284611595c0b325b842f453d4ec20ce6829d6901d8b`

- The private host directory/file remain `0700`/`0600`; the file is owned by the current user and contains the correctly named nonempty variable.
- A trusted bootstrap receives the credential through standard input, places it only in a private tmpfs directory, and launches a probe under worker UID/GID **10002** using the existing supervisor environment filter and Node env-file loading. The worker reported successful loading with live approval off.
- An OS-level probe under web UID/GID **10001** had no key in its environment and received permission denial when reading either the worker's secret file or `/proc/<worker-pid>/environ`.
- The container had **network=none**, read-only root filesystem, no host bind mounts, no Docker socket, no published ports, no automatic restart, and bounded memory/process/CPU resources. The host private directory was absent from its filesystem.
- The credential was absent from Docker configuration/environment metadata and container logs. Only boolean status, UIDs and the nonsecret image identity were emitted. The container and its tmpfs were removed afterward.

This verifies the isolated container boundary, not filesystem separation between arbitrary macOS processes running as the same user. The approved future trial must use this worker-only isolation pattern: no web server, no host home/repository mounts containing secrets, no Qloo/Gemini/Anthropic credentials, and no automatic restart. Only after explicit paid authorization may its network profile permit the local ledger database and the fixed DeepSeek endpoint; the preflight itself never enabled networking. The trusted host/Docker administrator remains outside the web-user threat boundary.

## Model, prices and accounting

Official documentation rechecked on 2026-10-23:

| Item | Confirmed / proposed value |
| --- | --- |
| Trial model ID | `deepseek-v4-pro` |
| Documented version behind the alias | DeepSeek-V4-Pro-0813; actual response model must still be validated |
| Endpoint | `POST https://api.deepseek.com/responses` |
| Structured output | `text.format.type=json_schema`, plus strict application schema and semantic validation |
| Peak price, uncached input | CNY 9 / million tokens |
| Peak price, cached input | CNY 0.30 / million tokens |
| Peak price, output including reasoning | CNY 27 / million tokens |
| Alternative, excluded from this trial | `deepseek-flash`: peak CNY 2 / 0.04 / 8 per million uncached/cache-hit/output tokens |

Sources: [DeepSeek CNY pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/), [Responses compatibility](https://api-docs.deepseek.com/guides/responses_api/). Use peak prices even during cheaper hours; no tools or search/fetch services will be requested. Current account authentication and actual serving model are unverified because no API request was made.

Today's [CFETS fixing as reported by Xinhua](https://www3.xinhuanet.com/fortune/20261023/eb92ef669b8341f1bef90821f44ff3fa/c.html) was CNY 6.7180 per USD, or approximately USD 0.148854 per CNY. The proposed internal accounting factor is **USD 0.20 per CNY**, about **34.36% above** that reference. This is an intentionally conservative ledger conversion, not a bank execution quote or an actual currency exchange. It is now supported by this dated review for the proposed plan; it has not been enabled in private runtime configuration.

- Native CNY allowance: **2**; equivalent USD ledger cap: **0.40** at the proposed factor. Existing smaller caps remain binding.
- Before each call, M10-A reserves against global, workspace, experiment, run and grant caps. DeepSeek forces invite authorization and clamps persistent USD limits to the native allowance times the reviewed factor.
- The future single trial run must have durable `maxLlmCalls=2`, `maxLlmOutputTokens=16384` and `maxEstimatedCostUsd=0.40`, with a single-run grant capped at USD 0.40. These records are to be created/verified after execution authorization; none was activated by this preflight.
- Invalid, absent, nonfinite, nonpositive or expired pricing/conversion review fails closed. Reviews expire after 24 hours and future timestamps are rejected. Re-review at execution time if this dated review is stale; do not merely advance the timestamp.
- Valid usage separates cache hits from uncached input. Reasoning tokens are included in total output tokens and are not billed a second time. USD reservations/settlement round upward to micro-USD; the provider-billed CNY amount must be reconciled separately.
- Unknown usage retains the reservation; overrun latches further paid work off. No request, output repair, truncation retry, model fallback, manual retry or automatic restart is included in this plan. A lost/failed attempt is not permission to repeat it.

## Exact two-call quality case

Frozen fixture: `tests/fixtures/deepseek-quality.ts`, plan ID **deepseek-synthetic-quality-v1**. All names, UUIDs and evidence are locally invented; no real Qloo material is read or transmitted.

Scenario: a 24-seat, low-budget cafe wants a 90-minute book/music/film conversation evening, combining the invented Paper Atlas Stories, Velvet Static Radio and Lantern Ferry Sketches. There is no real attendance, revenue or audience evidence.

1. **R3 generation** (`r3.generate`, version `1.1.0+bc45cdac3c4a`): produce exactly two distinct, testable cultural hypotheses using the supplied entity IDs. Creative additions must be marked `CREATIVE_SPECULATION`; do not present demand, attendance or sales as established facts.
2. **R4 evidence critique** (`r4.critique`, version `1.0.0+12094ffd182a`): critique a fixed synthetic hypothesis that deliberately claims aggregate taste overlap guarantees a sold-out event and increased sales. The supplied synthetic evidence explicitly lacks causal, attendance and revenue observations and is graded INCONCLUSIVE. Require a refine/retire recommendation and citation of the supplied synthetic evidence; no invented IDs, confidence upgrades or changed factual stance.

The critic input is fixed and independent of the generation output. This makes the challenge reproducible and the payload sizes known in advance. Run sequentially and stop before the second call on any first-call transport, usage, JSON, schema or semantic failure. Do not salvage a failed quality case into a passing result.

Hard local request settings:

| Limit | Per call | Total |
| --- | ---: | ---: |
| Generation requests | 1 | **2 maximum** |
| Serialized UTF-8 request body | ≤ 16,384 bytes | ≤ 32,768 bytes |
| Conservative reserved input tokens | ≤ 20,480 (bytes + 4,096 overhead) | ≤ 40,960 |
| Output tokens, including reasoning | ≤ 8,192 | ≤ 16,384 |
| Reasoning effort | low | same for both |
| HTTP deadline | 60 seconds | no retry on timeout |
| Conservative peak-price reservation | CNY 0.405504 | **CNY 0.811008** |
| USD ledger reservation, rounded upward | USD 0.081101 | **USD 0.162202** |

The actual frozen request bodies measured **8,747** and **4,506 bytes** in the offline dry run. Budgeting still uses the larger caps above. The remaining **CNY 1.188992** is headroom within the planned CNY 2 allowance, not authorization for extra calls. Token/byte estimates and local guards do **not** constitute a guaranteed provider-side billing ceiling. If an absolute account-side CNY 2 cutoff is required, that capability remains unverified and must be resolved before execution. Reconcile the reported prepaid balance/actual debits privately around the trial; do not claim estimated charges are actual billed amounts.

Quality report after authorization:

- JSON parsing, schema, unknown-field rejection, known entity/evidence IDs and semantic verdicts.
- Two-hypothesis originality/distinctness, meaningful cross-domain connections, small-venue feasibility and testability (human rubric: 0–2 each, 8 maximum; scores are judgments, not model confidence).
- Whether the critic challenges the unsupported causal/demand conclusion while preserving the supplied stance and synthetic provenance.
- Same-input scripted baseline comparison, clearly labelled deterministic and synthetic. Its successful offline output is not proof of live creativity.
- Actual response model, token/cache/output/reasoning counts, conservative CNY/USD estimate, separately reconciled provider debit, error/stop behavior. Do not retain reasoning traces or credentials.

## Completed offline checks

- Actual credential isolation probe: **passed**, network disabled and container removed.
- DeepSeek adapter, six application contracts, and the exact two-case dry run: **42 tests passed**.
- PostgreSQL spending/access/settlement suite: **20 tests passed**. Includes durable attempt/token ceilings, invalid accounting, unknown billing, overrun latch, grants, and CNY-to-USD conversion.
- Exact fixture dry run: scripted baseline and mock DeepSeek Responses passed real application schemas/semantic validators; invented entity IDs and invalid evidence citations were rejected; a third provider request was blocked.
- Type checking, ESLint and formatting: **passed**.

**Decision:** ready to request separate authorization for the specified isolated, two-call synthetic trial, subject to a fresh review at execution time. Not evidence of live model quality, valid API authentication, actual billing, or real Qloo integration. Paid access remains off. The original checkpoint is preserved; this report, isolated probe and fixture tests are local additions only.
