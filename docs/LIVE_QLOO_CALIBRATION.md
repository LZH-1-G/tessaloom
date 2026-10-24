# Phase 2 — Real Qloo API calibration

Updated **2026-10-24 (Asia/Shanghai)**. Branch: `codex/live-provider-validation`. Base checkpoint: `6e210c2` (DeepSeek/Gemini integration). The two successful synthetic DeepSeek calls and their [report](DEEPSEEK_LIVE_TRIAL_2026-10-23.md)/[evidence](evidence/deepseek-quality-2026-10-23.json) are preserved. This phase made **zero Qloo API HTTP requests, consumed zero additional Qloo quota, and made zero DeepSeek/other model calls**. Public documentation reads are not Qloo service calls.

**Status: safe offline audit and provenance repair completed; real calibration remains BLOCKED on authoritative quota/permitted-use information and separate owner approval. Real Qloo + DeepSeek E2E is NOT ready.** No deployment, push, merge or organizer message was sent.

## Repository and prior evidence

The starting checkout had the committed adapters at `6e210c2` plus uncommitted DeepSeek preflight, fixtures, isolated test harnesses and redacted synthetic results. They were preserved and included in the local checkpoint alongside this repair; no history was reset or amended. Relevant decisions reviewed: ADR-003/014 (supported Harness surfaces and fixture separation), ADR-019/021 (V1 behavior and adapter), ADR-020 (raw retention off), ADR-025 (honest insufficient evidence), ADR-027 (What-if dependencies/cache reuse).

The [V1 report](research/QLOO_V1_VALIDATION.md) records 20 Harness invocations on 2026-10-21; the M2 ledger in `TEST_PLAN.md` records three more. **These historical invocation counts are not wire-level HTTP counts, nor evidence of current remaining quota.** A name-resolving workflow may issue multiple HTTP requests. No historical raw responses were loaded into this audit or sent to a model.

| Capability | Historical live finding | Current phase verification |
| --- | --- | --- |
| Search/resolution | IDs, `types[]`, legacy author types, ambiguous editions/localities | Pinned Harness source and network-blocked dry runs; synthetic normalization regressions |
| Cross-domain recommend/rank | Generic `type=urn:entity`; category in `subtype`; affinity and ordered results | Existing normalizers/validators reviewed and tested offline; no fresh response |
| Compare audiences | Profiles/overlap lists, no supplied similarity score; requested limit not always honored | Existing structural handling; numeric conclusions remain limited |
| Geography/demographics/trends | Geohash cells; relative demographic indices; book trends rejected and some windows empty | Existing unsupported/insufficient handling; no live revalidation |
| Auth/errors | Historical `QLOO_AUTH` and `QLOO_CONTRACT` | Credential configuration only; current validity/HTTP status/rate headers unknown |

Affinity is an aggregate audience signal, not creative quality, causation, attendance probability, sales or a guaranteed outcome. No numeric threshold was newly calibrated.

## Private configuration audit

The reproducible [offline audit helper](../tests/security/qloo-offline-preflight.mjs) and [safe result](evidence/qloo-phase2-offline-preflight-2026-10-24.json) establish:

- Installed official Harness **0.1.26**, matching the previously audited transport implementation. The installed CLI uses one `fetch` for direct `qloo api search` and `qloo api insights`; workflow fan-out is a separate concern.
- A credential is present in the Harness's private config, owned by the local user, mode **0600**, not a symlink. Only existence/source and permissions were reported. Its issuer, current validity and expiry cannot be established from that local file.
- No repository `.env` was present; the shell did not supply the Qloo endpoint variables. Without overrides, the installed Harness resolves the trusted production endpoint `https://api.qloo.com/`. **Do not use that default for event calibration.**
- Explicit `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL`, both `https://hackathon.api.qloo.com`, pass offline doctor auth-configuration/trust checks. No `doctor --network`, setup login, credential change or health API probe was run.
- The three dry runs had networking blocked in their subprocesses and used invented placeholder UUIDs for Insights. They verified CLI syntax and request parameter names, not authentication or accepted server parameters.
- Harness 0.1.26 dry-run prints the config-file/default production URL despite event endpoint environment overrides. This was reproduced and corroborates [kit discussion #3](https://github.com/qloo/qloo-hackathon-kit/discussions/3). Doctor/configuration resolution and the future exact-URL wire guard, not the preview URL, establish endpoint trust.
- Model/database secrets are excluded from Qloo child environments. Existing `QLOO_RAW_RETENTION` default remains **off**. No Qloo credential was placed in the repository, web process, request plan, model prompt or report.

## Authoritative sources and unresolved permissions

Reviewed public sources on 2026-10-24:

| Source | What it establishes | What it does not establish |
| --- | --- | --- |
| [Official kit API_ACCESS](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/API_ACCESS.md) | Event-attributable credentials; supported Harness surfaces; shared quota; bounded usage; organizers should publish quota/rate/expiry | No account-specific total, remaining balance, reset or expiry values in this document |
| [Official kit SAFE_USE](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/SAFE_USE.md) | Aggregate/public signals, source labels, no causal claims, clarify ambiguity; warns that explore sends project content to a model | Does not settle this credential's permission for DeepSeek processing, retention or redistribution |
| [Official kit SUPPORT](https://github.com/qloo/qloo-hackathon-kit/blob/main/SUPPORT.md) | Q&A discussion channel for quota/access/workflow questions | No private credential-specific quota statement |
| [Official repository discussion #1](https://github.com/qloo/qloo-hackathon-kit/discussions/1), [#2](https://github.com/qloo/qloo-hackathon-kit/discussions/2) | Existing questions about quota, remaining usage, expiration and judging access | At review, both were **unanswered with zero replies**; questions are not organizer grants |
| [Qloo public Insights reference mirror](https://github.com/qloo/docs-public/blob/main/reference/insights-api-deep-dive.md) | Required `filter.type`, comma-separated signal entity IDs for GET, `take` range 1–50, affinity sorting | Does not prove the event endpoint/credential's current entitlements or quota |

The `docs.qloo.com` homepage/search URLs could not be retrieved by the web reader; the official `qloo/docs-public` Insights mirror was available. No docs-MCP execute-request tool was used. Public search also surfaced participant quota claims; **none were adopted as authority for this credential**. No applicable account dashboard, issuance notice or organizer reply giving remaining quota was available in the supplied materials.

Still unresolved: total event allowance, remaining requests as of a stated time, counting/reset rules, rate/concurrency limits, expiry/timezone, minimum normalized-evidence retention, public display/replay rights, and third-party processing by DeepSeek. The kit's “cache what is needed” guidance is not treated as permission for permanent raw-response archives or public redistribution. General support for model-enabled workflows is not treated as specific DeepSeek approval.

## Proposed three-request plan — NOT authorized or executed

Use only the pinned official **`qloo api`** surface in an isolated worker with the event endpoint explicitly trusted, no model keys, no automatic restarts and no raw-response logging. At most **three sequential HTTP GETs total**, zero retries, redirects, pagination, fallback or name-resolution fan-out. The first two public cultural names are chosen inputs, not claimed Qloo matches.

| Slot | Endpoint on `https://hackathon.api.qloo.com` | Exact parameter set | Purpose |
| --- | --- | --- | --- |
| 1 | `/search` | `query=The Beatles`, `types=urn:entity:artist`, `take=2` | Resolve the intended music group; inspect type and ambiguity |
| 2 | `/search` | `query=Spirited Away`, `types=urn:entity:movie`, `take=2` | Resolve the intended 2001 film; inspect available distinguishing metadata |
| 3 | `/v2/insights` | `filter.type=urn:entity:book`, `take=1`, `signal.interests.entities=<verified slot-1 UUID>,<verified slot-2 UUID>` | Minimal two-signal cross-domain result |

`take=2` for search is the smallest proposed ambiguity comparison; taking one result would not demonstrate uniqueness. Insights uses the documented minimum of one result. The third request is a conditional template: **real UUIDs do not exist in this plan yet**. No UUID is invented, guessed, copied from prior undocumented results or submitted during dry-run. If either entity is ambiguous, absent, mistyped, or insufficiently described, stop without slot 3 and request a choice; do not spend an extra request resolving it. Exact-name or top-ranked status alone is not sufficient confirmation.

The reviewed source maps these flags directly to those parameters without auxiliary lookups:

```text
qloo api search --query "The Beatles" --type artist --take 2 --json
qloo api search --query "Spirited Away" --type movie --take 2 --json
qloo api insights --type book --signal-entities <verified-artist-UUID>,<verified-movie-UUID> --take 1 --json
```

**Expected local budget impact: at most 3 HTTP dispatches.** Provider quota debit cannot be asserted until organizers confirm counting rules, including failed requests. No extra “remaining quota”, balance, health or metadata request is included. Obtain a dated authoritative quota statement first, then present this parameter plan and quota source for explicit owner approval. Stage slot 3 only from verified returned IDs within that approval; if choosing a match requires human clarification, pause with the remaining slots unspent.

The existing calibration preload now supports an **exact expected URL** for Insights while retaining search-only defaults. Its offline tests reject modified parameters, pagination, other endpoints, redirects and a second dispatch, including after HTTP 429. This does not authorize execution. The existing opt-in `providers.test.ts` is the older three-search probe, **not this Phase 2 plan**; do not run it as a substitute. Before an approved execution, assemble/review the three-slot parent runner with a durable exclusive receipt and metadata-only collector, pin each child's exact URL, and stop on the first error. Ordinary CI cannot run live provider tests, even with injected credentials.

For a future approved response, inspect body and normalization in trusted local worker memory; persist only permitted metadata: dispatch count, UTC timestamps, endpoint/parameters as permitted, status, schema field paths/types, missing/heterogeneous fields, normalized result count and validation verdicts. Capture only allowlisted nonsecret rate-limit headers if supplied. Keep source retrieval and reuse timestamps separate. Do not deliberately provoke an authentication/rate error within this budget. Any IDs/facts retained for traceability require the applicable permission; raw body retention/public display stays off. No returned Qloo material is to be sent to this or another third-party model without separate permission and authorization.

Fresh compatibility remains **unverified**: raw `qloo api insights` is not the workflow envelope consumed by `normalizeRanked`; an approved collector must inspect the actual raw nesting and explicitly compare its entity list with the existing normalizer, without fabricating a Harness provenance envelope. One-result Insights cannot calibrate population thresholds, ranking quality, pagination or E2E cultural validity.

## Provenance repair and offline verification

The adapter already kept the original retrieval date in memory, but cached DB invocations dropped the structural snapshot link, correlation/endpoint/request details, and read models displayed the newer invocation `created_at` as retrieval time. What-if reuse created a similarly fresh-looking trace.

Changes:

1. Cache recorder reuses the original structural snapshot and request metadata, with a project-boundary check. No raw response is copied; raw retention remains off.
2. A shared DB source-time expression resolves original snapshots through cache chains (including historical rows without snapshot links), constrained to the same project and bounded to 32 links. A broken/cyclic chain returns unknown rather than the reuse timestamp. When a legacy original invocation has no snapshot, its original record time is the only available fallback; this does not recover a more precise lost response timestamp.
3. Experiment entity/evidence read models, invocation/evidence traces and blueprint appendices use that source time. `invokedAt` separately reports when the current invocation/reuse was recorded. Existing immutable rows and schemas are preserved; no migration or backfill is needed.
4. The trace dialog labels **Originally retrieved** separately from **Reused** / **Invocation recorded** and renders missing source time as **Unknown**.
5. Regression tests cover persistence with raw retention off, complete source metadata, same snapshot/date on cache hits, nested historical cache rows, Evidence Graph trace targets, successive What-if branches, fixture labels, and absence of extra What-if transport calls for reused queries.

Vocabulary remains compatible with existing schemas:

| Requested concept | Existing representation |
| --- | --- |
| LIVE_QLOO | `QLOO_SOURCED` + `dataOrigin=LIVE` |
| CACHED_QLOO | `QLOO_SOURCED` + `dataOrigin=CACHE`, linked original invocation/snapshot |
| FIXTURE | `DEVELOPMENT_FIXTURE` + `FIXTURE`; reused synthetic evidence may have `CACHE` delivery but stays `DEVELOPMENT_FIXTURE` |
| AI_INTERPRETATION | `MODEL_INTERPRETATION` |
| CREATIVE_SPECULATION | `CREATIVE_SPECULATION` |

Evidence Graph and What-if tests confirm that synthetic evidence is never upgraded to Qloo provenance. Existing evaluator tests retain honest `INSUFFICIENT`/`UNTESTABLE` outcomes for missing fields, unsupported combinations and thresholds pending calibration. Qloo facts remain linked to stored evidence, invocation IDs, request hashes, source timestamps and JSON-pointer verification at ingest; this is not a claim that raw response replay is available with retention off.

### Offline validation — 2026-10-24

| Check | Result |
| --- | --- |
| Full unit suite | 25 files, **387 tests passed**, including the exact-URL/one-dispatch calibration guard |
| Full integration suite, isolated local PostgreSQL databases | 14 files, **81 tests passed**, including adapter persistence, legacy cache chains, Evidence Graph, two generations of What-if reuse and blueprint appendix |
| Chromium + WebKit regression | **6 tests passed**: Evidence Graph/trace, activity monitor and What-if journeys |
| Type checks | Root, script, web and worker checks passed |
| Production build | Web, worker and DB builds passed; no deployment performed |
| Bundle credential check | Passed, **670 files** checked |
| ESLint, Prettier, diff whitespace | Passed |
| Gitleaks 8.30.0 | Changed/new files scanned in a network-disabled, read-only container; **no leaks found** |
| Private Qloo configuration and guarded CLI dry-runs | Passed offline; safe results saved in the linked preflight evidence; **0 HTTP dispatches** |

The first full integration invocation stopped because its local `DATABASE_URL` was unset; supplying the local-only test setting produced the passing result above. Existing PostgreSQL client-concurrency deprecation warnings remain non-fatal. Browser tests used synthetic Qloo and scripted AI. No live provider suite, remote CI or public deployment was run. Previous DeepSeek live-test artifacts are preserved unchanged in this checkpoint; their paid tests were not repeated.

## Organizer questions — draft only, NOT sent

Suggested channel: the official [Q&A discussions](https://github.com/qloo/qloo-hackathon-kit/discussions/categories/q-a), referencing unanswered #1/#2; use a private organizer channel for account-specific details. Never include a credential, authorization header or key fragment.

> We are building Tessaloom with official Qloo Harness 0.1.26 on macOS and Node 26.11.1, using the event endpoint from a private local worker. We have paused live requests pending clarification. Could an organizer confirm the following for our event-issued credential, identified privately by registration/account reference rather than the key?
>
> 1. What are its total quota, remaining allowance as of a stated UTC time, reset rules, rate/concurrency limits, and exact expiry with timezone? What authoritative dashboard/notice provides this without consuming a trial API request? Will it remain usable during judging?
> 2. Is quota counted per HTTP request or weighted by endpoint? Do errors/timeouts count? Please confirm whether the proposed two `/search` calls (`take=2`) plus one `/v2/insights` call (`take=1`) are permitted and their maximum quota impact. Is there any charge/overage behavior?
> 3. May we keep the minimum normalized facts needed for provenance (entity IDs, types, affinities/ranks, query metadata, source dates and fact pointers) privately? What retention period/deletion rules apply? Separately, may raw responses, normalized facts or screenshots be retained or displayed in a public judging demo/replay, and with what attribution?
> 4. May minimal Qloo-derived facts be sent to the official DeepSeek API for hypothesis critique/blueprint generation? Which fields, processing regions, retention/training terms or contractual safeguards are required? Please provide the applicable event/API terms or a written permission statement. We will obtain the project owner's separate authorization before any such transfer.

## Readiness and next step

**No live calibration or Qloo + DeepSeek E2E is authorized by this report.** First obtain the organizer/account-specific quota, expiry and applicable retention/use answers. Then finalize the bounded collector and exact conditional request plan and seek explicit approval for Qloo-only calibration. After genuine response compatibility/provenance is verified, obtain DeepSeek-sharing permission, a fresh cost review and separate owner approval for a bounded E2E experiment. Unused previous DeepSeek budget is not new authorization.
