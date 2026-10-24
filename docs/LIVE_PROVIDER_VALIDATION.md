# Live provider validation — local preparation

Date: **2026-10-23**. Branch: `codex/live-provider-validation`.
Baseline: `d363f00` (merged M10-B); fetched `origin/main` and verified identical before editing.

**Status: offline integration implemented; live calibration and authentic demonstration BLOCKED, not completed.**
No live Qloo requests, DeepSeek requests, Gemini metadata requests, Gemini generation requests, Anthropic calls, cloud deployment, billing changes, pushes or merges were made in this task. Live token usage and measured API charges: **0 / none incurred by this task**. This is not an account billing audit. Existing historical Qloo observations are explicitly separated below.

## DeepSeek is the preferred live evaluation provider

The owner switched from Gemini to DeepSeek. Anthropic, scripted AI and the implemented Gemini adapter are preserved. Development defaults remain scripted; possession of a key does not activate paid access. `LLM_PROVIDER=deepseek`, standard mode selects `deepseek-v4-pro`; economy mode explicitly selects `deepseek-flash`. There is no automatic cheaper-model or cross-provider fallback.

Official specifications reviewed **2026-10-23**:

| API model ID | Current documented version | Peak CNY / million input cache miss | Cache hit | Output including reasoning |
| --- | --- | ---: | ---: | ---: |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 9 | 0.30 | 27 |
| `deepseek-flash` | DeepSeek-V4.1-Flash-1017 | 2 | 0.04 | 8 |

Sources: [official CNY pricing and model IDs](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/), [Responses API](https://api-docs.deepseek.com/guides/responses_api/), [response creation specification](https://api-docs.deepseek.com/api/create-response/), [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/).

The dedicated adapter uses `POST https://api.deepseek.com/responses` with `text.format.type=json_schema`, application Zod validation and existing semantic/evidence validators. No SDK or hidden SDK retry is involved. Reasoning effort maps to low/high/max; thinking text is discarded. `output_tokens` already includes reasoning tokens: the latter is reported separately but never charged twice. Cached input is separated from uncached input. Incomplete/invalid usage and unapproved response model IDs fail closed. Redirects, tools, automatic retries, output repairs and truncation retries are disabled for DeepSeek's initial trial. Error messages omit response bodies and transport details.

All six application prompt contracts (intent, generation, revision, critique, comparison, blueprint) have offline schema tests. These use invented outputs inside mock Responses envelopes; they do **not** establish real model schema compliance or cultural quality. Existing semantic validation, deterministic claim evaluation, citation integrity, numeric fidelity and provenance labels remain enforced. DeepSeek rejects unknown output fields rather than silently stripping them. Actual Qloo or uncertain input provenance is blocked before network dispatch; counterfactual contexts remain conservatively blocked pending their separate lineage review.

### Credentials and isolation verified locally

The existing `~/.config/tessaloom/deepseek.env` contains a nonempty, correctly named `DEEPSEEK_API_KEY`. Its parent is `0700` and the file is `0600`. Verification printed only booleans, never the value, fragments, hashes or length. No replacement key was created.

A one-shot offline check loaded this file with Node's `--env-file` and passed its environment through the **actual supervisor `buildChildEnv` and worker parser**. Worker loading succeeded; the web environment omitted the key; web validation rejected accidental injection; live activation stayed off. The file is **not automatically discovered** by Tessaloom: the owner must explicitly supply `--env-file=/Users/lzh/.config/tessaloom/deepseek.env` to the trusted supervisor/worker launcher after approval. Do not source it into a web development process or copy it into the repository. Qloo child environments exclude this key too.

Important boundary: local web and worker processes running as the same macOS user can read that user's `0600` files. Environment filtering does not provide filesystem isolation. The existing root supervisor with distinct container UIDs provides that stronger boundary; container regressions use fake credentials only. The real host file was not mounted into a container, and no claim is made that an arbitrary same-user web process cannot read it. For the first live trial use a worker-only session with no web process, or separately review an isolated worker container launch. Existing production Compose file-secret provisioning remains Anthropic-oriented and is not being deployed or silently rewired.

### Currency accounting and activation

DeepSeek charges this account in CNY; the application ledger remains USD. The implementation uses a separate native micro-CNY allowance and converts the **peak CNY tariff** to USD for M10-A reservations and settlement. It does not mistake DeepSeek's public USD tariff for a foreign-exchange rate. Cache discounts are applied only to validated returned usage; peak rates are always used regardless of time-of-day discounts.

`DEEPSEEK_USD_PER_CNY` must be a finite, positive, explicitly reviewed conservative rate. `DEEPSEEK_PRICING_VERIFIED_AT` certifies review of both tariff and conversion; future/invalid timestamps or reviews older than 24 hours disable dispatch. The rate and tariff review metadata are persisted with invocations. The offline rate `0.20` is a **test fixture only**, not a current market quote or approval for live use. No live conversion rate has been confirmed. If pricing/FX is uncertain, stop and review before supplying either setting.

M10-A still reserves before each request against global, workspace, experiment, run and grant limits. For DeepSeek the worker clamps the persistent global/workspace/experiment USD caps to at most the approved CNY allowance times the reviewed conversion, and forces invite access even if a development configuration says open. Missing/invalid conversion disables spend. Unknown billing retains the full reservation. Known usage settles the USD ledger, rounded upward to micro-USD. An overrun latches further paid work off. DeepSeek additionally reserves native CNY before awaiting HTTP and never refunds/reuses that allowance during the worker lifetime. Concurrent attempts share the same four-call and native-budget limits. This local allowance resets with a new worker; **do not restart or manually retry under the same trial approval**. Persistent application ledger limits continue across restarts. A separate durable trial approval/receipt and balance reconciliation must precede a resumed trial.

Keep disabled now:

```dotenv
LLM_PROVIDER=deepseek
LLM_MODE=standard
QLOO_MODE=synthetic
RUN_ACCESS=off
DEEPSEEK_LIVE_APPROVED=off
DEEPSEEK_MAX_REQUESTS=0
DEEPSEEK_BUDGET_CNY=0
QLOO_RAW_RETENTION=off
# DEEPSEEK_USD_PER_CNY and DEEPSEEK_PRICING_VERIFIED_AT remain unset.
```

Do not enable open public access. Approved future tests must use a local authorized run/grant and the normal DB-backed worker spending guard. The existing `test:live` command has Gemini/Qloo probes only; it is **not a DeepSeek shortcut around the DB ledger**.

### Exact proposed initial trial — not authorized or run

- Total owner budget: **at most CNY 2**. Existing prepaid balance **CNY 16.06 is owner-reported**, not independently queried. No purchase or recharge is needed.
- Maximum **four sequential generation requests**, all `deepseek-v4-pro`: intent, cultural hypothesis generation, critical evaluation, blueprint composition. Use only locally invented entities such as Paper Atlas Stories and Velvet Static Radio and explicitly synthetic evidence. Revision/what-if and Flash live comparisons require a separate later approval; no additional calls are included.
- Each serialized request must fit **16,384 UTF-8 bytes**. Reservation assumes every byte is an input token, adds **4,096** protocol overhead tokens, and reserves **8,192 output tokens including reasoning**. Actual application caps may be smaller. An oversized payload is rejected, not truncated or automatically resubmitted.
- Maximum proposed reservation per request: `(20,480 × 9 + 8,192 × 27) / 1,000,000 = CNY 0.405504`. Four requests reserve **CNY 1.622016**; **CNY 0.377984** remains as budget headroom, not authorization for a fifth request. USD equivalents are these values multiplied by the separately verified USD-per-CNY rate.
- No repair, truncation, HTTP retry, provider fallback, tools, automatic restart or parallel runs. Stop on the first failure or accounting uncertainty. A full application loop can contain more than four LLM calls; this approval scope would stop before such a fifth call and is not authorization for an unrestricted E2E run.
- **Token/request estimates are not a guaranteed provider billing ceiling.** Before dispatch, confirm current prices and conservative FX and the ability to reconcile actual billing; use a provider-side budget cap if available. Record starting balance privately, reconcile after each call, and stop on unexpected debit/usage. If the owner requires a guaranteed hard account-side CNY 2 ceiling, that remains unverified and live testing must stay blocked.
- Score hypothesis originality, distinct cultural connections, testable claims, evidence/speculation separation, critique restraint and blueprint feasibility. Compare against the same synthetic scripted baseline. Preserve actual model IDs, prompt versions, schema/semantic verdicts, visible validated outputs, input/cache/output/reasoning counts and estimated CNY/USD costs; never retain internal reasoning traces. Reconcile provider-billed CNY separately from conservative estimates.

Current live results: **no models tested live, no live tokens, no billable requests, no model quality comparison or actual billing measurement**. Pro and Flash transport behavior is mocked; scripted AI remains a deterministic baseline, not evidence of DeepSeek creativity.

## Authorization and activation gates

The owner confirmed during this task:

- Qloo event quota and permitted usage remain unverified. Prepare **at most three HTTP requests, zero retries**, but make none until these are confirmed.
- **No permission** to send Qloo-derived data to free-tier Gemini or retain raw Qloo responses for a demonstration. Only synthetic fixtures and locally invented inputs may be used in offline tests.
- Gemini credentials will be configured privately later. Account model availability, Free tier, RPM, TPM and RPD are unconfirmed. No paid billing or paid calls.
- **Ask for approval before the first live end-to-end experiment**, even after prerequisites are supplied. Do not run the contract probes or experiment automatically on startup, in CI, or because a key appears.

No approval is encoded by this document. All runtime Gemini gates default to off/zero. `QLOO_RAW_RETENTION=off` remains unchanged.

## Repository and Qloo audit

Read the adapter, CLI/MCP router, readiness checks, normalizers, recorder, worker composition/orchestrator, agent steps/evaluators, spending ledger, API/security contracts, and test plans. No project `AGENTS.md` was present outside installed dependencies.

Local-only checks confirmed:

- Installed official `@qloo/qloo-harness` **0.1.26**, executable `/opt/homebrew/bin/qloo`.
- Its private local configuration exists with mode `0600`. The key value was not printed or copied.
- `qloo doctor --json` **without `--network`**, with the two event endpoint variables set, reported credential configuration and endpoint trust as OK. This is configuration readiness, **not fresh authentication**.
- Target event endpoint: `https://hackathon.api.qloo.com`; both `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` must match. Neither was inherited in the original agent environment. The unconfigured harness defaults to the production endpoint.
- CLI search uses one `fetch` to `/search` in the installed `dist/router.js`. Workflows can resolve names and then request insights, causing multiple HTTP requests per Harness invocation. Existing daily/run Qloo counters measure **Harness attempts**, not a guaranteed HTTP upper bound. MCP/CLI routing can also have different retry behavior. Do not interpret the existing 300-invocation default as an event-approved quota.
- Qloo retry errors previously disappeared before persistence. Each transport/envelope attempt is now recorded before a retry; quota reservations still precede each live attempt. This improves the invocation ledger but does not turn it into a wire-level quota meter.
- CLI, MCP and readiness subprocess environments now exclude DeepSeek/Gemini/Anthropic keys, database credentials and injected `NODE_OPTIONS`.

### Historical findings, not revalidated here

[The 2026-10-21 V1 report](research/QLOO_V1_VALIDATION.md) documents 20 Harness invocations; the test ledger later records three more M2 calls. These are historical **invocation counts**, not a newly measured HTTP count or remaining quota.

| Contract | Historical observation | Current verification |
| --- | --- | --- |
| Authentication | `QLOO_AUTH`, nonzero exit; trusted event endpoint | Local configuration only |
| Search/disambiguation | Search array; identical names can span types; exact name can select an alternate edition | Synthetic regression only |
| Recommend/rank | Category lives in `subtype`, generic `type=urn:entity`; aggregate affinity is not creative fit | Normalizer/evaluator regression |
| Audience | Relative demographic indices, not population percentages; comparison has no similarity score | Synthetic regression |
| Trends | Book rejected; some type/date windows empty | Existing unsupported/insufficient behavior retained |
| Pagination | `take`/`limit` cap results; audience comparison historically exceeded requested limit | No page traversal performed; pagination unverified |
| Rate limits/timeouts | Quota, expiry and 429 shape unknown | Offline failure injection only |
| Source dates | Retrieval timestamp is not source dataset publication/update date | No new source dates claimed |

### Prepared three-request calibration

`pnpm test:live` is separate from all normal test commands. Its config rejects CI and requires explicit local approval and a selected provider. The Qloo case requires:

- `LIVE_VALIDATION_APPROVED=yes`, `LIVE_VALIDATION_PROVIDER=qloo`;
- `QLOO_QUOTA_CONFIRMED=on`, `QLOO_CALIBRATION_HTTP_CAP=3`;
- `QLOO_CALIBRATION_BIN=/opt/homebrew/bin/qloo` (resolved package name and version must match the audited 0.1.26 installation);
- an absolute `LIVE_VALIDATION_RECEIPT` path in a private local directory. Exclusive creation refuses reuse of the same receipt, including after failure.

It performs three sequential, read-only searches, each with `take=2`: Agatha Christie/book, Lisbon/locality, and Murder on the Orient Express/book. Each subprocess preloads `scripts/qloo-calibration-guard.mjs`, which allows **one fetch only**, to the exact HTTPS event `/search` endpoint, GET only, with redirects disabled and a 15-second deadline. It rejects workflow fan-out and retries before dispatch. The parent stops on first failure; no fourth child is launched. The parent timeout is 20 seconds per child.

Only counts, structural field names and category URNs are retained. Names/IDs/results/raw envelopes are not persisted. Failure output is suppressed. On failure the receipt reports reserved HTTP slots as an upper bound, not a fabricated successful request count. This probe checks authentication/search shape only; it cannot establish affinity, audience, pagination, quotas or E2E readiness. Changing Harness version requires re-auditing this fetch boundary. This specialized guard is **not** installed in the ordinary application worker.

## Gemini integration

The adapter uses Google's supported `generateContent` REST endpoint on the fixed host `generativelanguage.googleapis.com`, with `x-goog-api-key` authentication. No new dependency was needed. Anthropic and scripted adapters remain available.

Capabilities and controls:

- Existing role/system prompts, `user`/`model` conversation mapping, JSON Schema output configuration, and application Zod plus semantic validation.
- Exactly one candidate; explicit output cap (maximum 32,000), 128 KiB local input cap, 2 MiB response cap, bounded deadline/cancellation, no redirect following, SDK retries, tools, grounding, files or explicit server caches.
- Gateway repair remains at most one; truncation may retry once within the ceiling. Each attempt must reserve through M10-A first and consumes the Gemini process cap. HTTP 429/5xx are classified; Gemini never switches models/providers or retries these automatically.
- No fallback, even if legacy `LLM_FALLBACK_MODEL` or economy mode is configured. Worker run metadata reports the selected Gemini model for both model slots; gateway fallback is disabled.
- Provider output model must equal the configured model. Missing/invalid usage or unexpected serving models fail closed. If Google introduces a version suffix/alias, review it explicitly before accepting it.
- Input accounting subtracts cache hits from prompt total; cached tokens are separate. Output includes candidate plus thinking tokens. Thought text is discarded. Missing or inconsistent usage is rejected.
- Conservative reservations use the published paid text rates even for a confirmed Free project; settled estimates are $0 only after the owner confirms Free eligibility. Reservations, grant checks, kill switch, daily/workspace/experiment caps and run call/token limits remain required. Unknown outcomes retain the reservation.
- Failed attempts are persisted with safe error categories. Unknown usage has an explicit `USAGE_UNKNOWN` marker. Activity views show unavailable usage/unknown cost rather than a measured zero; their totals become a known subtotal. Provider-local refusal before dispatch is distinguished from an attempted network call.
- `GEMINI_MAX_REQUESTS` is an additional **per-worker-lifetime cap**, including concurrency and repairs. Restarting resets this cap; persistent DB per-run attempt/token budgets remain. It is not an account-wide RPM/TPM/RPD limiter or authorization to restart and consume more quota.

### Model and account status

Official pages reviewed on 2026-10-23 list `gemini-3.5-flash-lite` with structured output and a free tier. The adapter also allows `gemini-2.5-flash-lite` and `gemini-2.5-flash`; Google currently restricts 2.5 access for new projects. These are **candidate IDs, not verified account access**. There is no default automatic Gemini model selection.

The public standard text paid rates used only for conservative reservations are, respectively, input/output per million tokens: $0.30/$2.50, $0.10/$0.40, and $0.30/$2.50. No paid calls are authorized or enabled. API responses do not prove that the key belongs to a Free project. `checkGeminiModel` performs one metadata GET and explicitly returns `billingVerified=false`, `quotaVerified=false`.

Sources: [pricing](https://ai.google.dev/gemini-api/docs/pricing), [model capability](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [model availability](https://ai.google.dev/gemini-api/docs/models), [account rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [REST contract](https://ai.google.dev/api/generate-content), [structured output](https://ai.google.dev/gemini-api/docs/structured-output).

### Terms and transfer permissions

Google's [unpaid-service terms](https://ai.google.dev/gemini-api/terms) allow product/model improvement using inputs and outputs and potential human review; they warn against submitting sensitive, confidential or personal information. Regional/account exceptions exist. Review the owner's actual eligibility, [supported region](https://ai.google.dev/gemini-api/docs/available-regions) and applicable terms; do not assume them from timezone.

Qloo event-specific storage, redistribution and downstream model-sharing rights remain unresolved. Public cultural entity names do not automatically authorize transferring Qloo-derived scores, profiles, descriptions or evidence. The owner's explicit denial is controlling. No Qloo-derived input may be submitted to free Gemini under the current authorization.

Agent prompts already project selected entity IDs/names/domains, claim/evidence summaries and necessary constraints rather than raw envelopes; critic prompts use bounded evidence excerpts. Raw snapshots, credentials, full provider properties and explanation payloads are not automatically forwarded. This minimization **does not replace sharing permission**. The live E2E experiment must remain blocked even if a synthetic Gemini smoke later passes.

## Preserved Gemini configuration — not the preferred live provider

In Google AI Studio, verify the API key's project is **Free**, has no paid billing, and has nonzero model-specific RPM/TPM/RPD for the proposed request count and token cap. Record the model, limits and verification date without the key. Do not click billing activation/upgrade to solve an unavailable model or exhausted quota.

Create a private directory outside the repository, e.g. `~/.config/tessaloom` with mode `0700`, and a `gemini.env` file with mode `0600`. Enter the key directly in a local editor, not in a terminal command argument, shell history, chat or browser application code. Its content can include `GEMINI_API_KEY=<your private value>`. Never commit this file. The supervisor forwards this key only to the worker; web environment validation rejects it; Qloo subprocesses also exclude it.

Nonsecret settings (keep disabled now):

```dotenv
LLM_PROVIDER=gemini
# Candidate only: replace with the exact account-verified supported ID.
LLM_MODEL=gemini-3.5-flash-lite
LLM_MODE=standard
GEMINI_FREE_TIER_CONFIRMED=off
GEMINI_DATA_SHARING_APPROVED=off
GEMINI_MAX_REQUESTS=0
GEMINI_TIMEOUT_MS=60000
QLOO_RAW_RETENTION=off
RUN_ACCESS=off
```

The opt-in Gemini contract probe requires explicit local approval, a new private receipt, the verified key/model and confirmations. It makes **one metadata GET plus at most one generation**, with locally invented text and a tiny schema; no Qloo material, no generation retries. It is **not** an end-to-end application experiment and uses a one-call local reservation rather than a DB application run. Do not interpret its success as all application schemas being accepted live. No live probe ran in this task.

## Experiment to run only after separate approval

Prepared public-input concept: a small book cafe wants a monthly mystery-and-music evening using selected public works as interests. No personal data or audience-level customer records. This is a **proposed experiment, not an authentic demonstrated result**.

| Stage | Current live status | Acceptance evidence required later |
| --- | --- | --- |
| Creative Brief | Not run | Actual model ID, validated intent, token/call receipt |
| Discovery / H2 | Not run | Real event endpoint, human disambiguation, source invocation/snapshot IDs |
| Cultural Collision / H2b | Not run | LIVE origins; aggregate affinity distinguished from creative fit |
| Hypothesis Evaluation / H3 | Not run | Interpretation/speculation labels; deterministic rules; every factual citation tied to stored evidence |
| Evidence Graph | Not run | Same stored IDs and evidence provenance, no model-invented facts |
| What-if / H4 | Not run | Preview dirty-query set and request budget; weights-only uses zero new Qloo requests; seed change recomputes only affected queries |
| Experience Blueprint | Not run | Cited factual blocks, bounded numeric claims, speculation labels, no fabricated outcomes/statistics |

The three-search calibration budget is **not** sufficient authorization for this full workflow. Before E2E, agree a separate small total HTTP/LLM budget after reviewing the query plan; enforce it at the actual network boundary, disable retries for the initial trial, isolate one local workspace, run one initial experiment, and stop on failure. Preserve H1/H2/H2b/H3/H4 human gates. An authentic demonstration must not be prepared from fixtures or historical summaries.

Persisted pointer-bearing evidence excerpts and local caching also need appropriate event permission. Raw retention stays off unless separately authorized. If no retention right is granted, a durable traceable demonstration cannot be declared complete. Publication/replay needs an additional rights review.

## Provenance and data-integrity audit

- LIVE, CACHE (UI cached), FIXTURE and scripted AI remain distinct. Cache records point to their original invocation and retain original retrieval/source metadata; cache access must not invent a new source date.
- Fixtures are not cached as live results. The production fixture/scripted guards and M10-A public access controls remain enabled.
- LLM hypotheses and narratives remain model interpretation or creative speculation. Factual evidence comes from deterministic extraction/evaluation and pointers. Empty/unsupported Qloo outcomes remain insufficient/inconclusive.
- What-if dirty-set computation, cached evidence origins, numeric-fidelity/citation validators, graph projection and blueprint checks are exercised by existing synthetic suites. This is **offline evidence only**; it does not establish live statistical validity or live model quality.

## Validation ledger

All implementation validation in this task uses mocks, synthetic Qloo fixtures or scripted LLM output. Gemini adapter tests fake the HTTP transport and use invented JSON, including invalid responses; they do not need a key. PostgreSQL and local Docker are real infrastructure, not provider services.

Verified locally on 2026-10-23:

| Check | Result |
| --- | --- |
| Unit tests | 24 files, **381 passed**; DeepSeek contract/provider tests use fake HTTP |
| PostgreSQL integration | 14 files, **80 passed**; final spending suite **20 passed** after the final budget changes |
| Type checking / lint / formatting / migration drift | Passed |
| Production web, worker and migration/admin builds | Passed |
| Runtime startup / security headers | **12 passed**, including DeepSeek key rejection without value logging |
| Browser journeys | **28 passed** in Chromium/WebKit, synthetic Qloo and scripted AI |
| Invite browser journeys | **2 passed**, unauthorized runs refused |
| Browser bundle credential canaries | Passed, **670 files** scanned; fake Gemini/DeepSeek keys used at build time |
| Dependency audit | No known production vulnerabilities; OSV **612 packages**, no issues |
| Secret scanning | Source snapshot (tracked plus new nonignored files) and existing Git history passed with redaction and network disabled |
| Final local ARM64 image | Built as `tessaloom:live-provider-validation` |
| Container smoke | Passed: fake DeepSeek/Gemini keys in worker only, web denied worker environment/home access, redaction, restart, readiness and shutdown |
| Disposable local deployment regression | Passed: protected mounted secret directory, separate UID environments, invite denial, TLS/proxy redaction, backup and restart recovery |
| Actual DeepSeek key loading | Boolean-only check passed; activation stayed off; no credential was placed in test artifacts |
| Paid/live provider tests | **Not run**; 0 provider requests from this task |

The startup-header test initially exposed a port-reuse race: the previous process had been signaled but not awaited. The helper now waits for process exit; all runtime checks passed afterward. An initial broad secret scan included dependency/build material and reported findings; the source-only snapshot and Git history scans are the relevant passing results, not a claim that every generated dependency file is secret-free. The initial container run caught a missing test argument separator; the final run passed after fixing it.

These are local checks, not remote CI/CodeQL, AMD64, public hosting or real-model acceptance. Host tools were Node 26.11.1 / pnpm 11.25.0; the image used the repository-pinned toolchain. No new dependencies or lockfile changes were needed. Local smoke resources were disposable; the existing development PostgreSQL service was retained.

**Readiness:** offline implementation and regression complete. The first paid test remains disabled pending explicit owner authorization, a current conservative FX/tariff review, and the isolated worker/authorized-run setup described above. No live DeepSeek output quality, real JSON success rate, real token usage or actual billed CNY can yet be reported. Real Qloo + DeepSeek remains blocked by quota and sharing/retention permissions.

## Remaining prerequisites

1. Confirm event quota, rate limits, expiry and permitted usage; then authorize the small calibration separately.
2. DeepSeek key is configured and offline loading verified. Confirm the current conservative CNY/USD conversion and tariff review, prepare an isolated worker-only trial with persistent spend limits, and explicitly approve the bounded synthetic test. Gemini account checks apply only if it is selected again.
3. Resolve Qloo downstream model-sharing and stored evidence/demo permissions. Current answer is **no permission**.
4. Obtain explicit approval for the first bounded E2E run and implement/review the per-experiment wire-level cap. Normal Harness invocation quotas are not sufficient.
5. Validate all seven live stages, actual accounting and source fidelity; produce the authentic demo only from that recorded run.
6. Before any future production deployment, complete live acceptance, monitoring/quotas, secret rotation policy, regional/terms review, approved data retention and the existing M10 deployment checklist. The M10-B production Compose secret wiring remains Anthropic-oriented; alternate-provider deployment secret provisioning requires separate review. No deployment is authorized now.
