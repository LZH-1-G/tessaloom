# V1 — Live Qloo Validation Report (redacted)

> **Date:** 2026-10-21 · **Milestone:** V1 (IMPLEMENTATION_PLAN §3) · **Surface:** official `@qloo/qloo-harness` 0.1.26 only
> **Endpoint:** `https://hackathon.api.qloo.com` (verified on the wire) · **Live calls used:** 20 of the 25-call budget
> **Redaction:** This report contains no credential, no raw Qloo response, and no Qloo entity IDs. Raw envelopes were kept only in a session-local scratch directory outside the repository and **are not committed**, pending confirmation of storage and redistribution rights (DECISIONS R-08). Seed names below are public titles that we chose as inputs.

---

## 1. Environment verification (before any live call)

| Check | Result |
|---|---|
| Harness | `qloo --version` = `0.1.26` |
| Credential | `qloo setup --status --json` reports `qloo.ready: true`, `source: config`, `mode: live`. The key itself was never read, printed, or copied. |
| Endpoint variables in the agent's shell | **Not inherited.** `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` were unset. They were exported explicitly for every live call. |
| Endpoint trust | `qloo doctor --json` with both variables reports *"Qloo API endpoint is explicitly trusted via QLOO_TRUSTED_BASE_URL: https://hackathon.api.qloo.com/"*. Without them, it reports the official production endpoint `https://api.qloo.com/`. |
| Wire check | `qloo api search … --verbose` logged the request to `https://hackathon.api.qloo.com/search` |
| Harness quirk | `qloo api <command> --dry-run` prints the URL from the **config file only** (default `https://api.qloo.com`) and ignores `QLOO_BASE_URL`. Real requests honor `QLOO_BASE_URL` plus trust (harness `router.js`, `createClient`). Do not use dry-run output to verify the endpoint. |

---

## 2. Capability discovery (no Qloo API calls)

- `qloo mcp` (server `qloo-harness` 0.1.26, MCP protocol `2024-11-05`) exposes exactly **10 tools**: `qloo_capabilities`, `qloo_recommend`, `qloo_rank`, `qloo_describe`, `qloo_where_popular`, `qloo_compare_audiences`, `qloo_entity_tags`, `qloo_audience_demographics`, `qloo_trends`, `qloo_find_tags`.
- `qloo exec` exposes the same nine workflows: `recommend, rank, describe, where_popular, compare_audiences, entity_tags, audience_demographics, trends, find_tags`. Its transport is "the direct Qloo API. No CLI or MCP fallback occurs."
- **There is no search workflow.** Plain entity search is available only through `qloo api search`.
- `qloo_capabilities` reports contract `1.0.0` and result schema `1.0-preview.1`. Upstream `api_version` is `2.0`, and the declared GET paths are `/`, `/entities`, `/search`, `/v2/analysis/compare`, `/v2/audiences`, `/v2/audiences/types`, `/v2/insights`, `/v2/tags`, `/v2/tags/types`, `/v2/trending`.
- For every workflow, `qloo_capabilities` reports: credential `qloo_api`; result budget 10 by default and 20 maximum; safe retry classes `dns, connect, timeout, rate_limit, upstream_5xx`; transports `direct, mcp`; concurrency `safe_for_independent_inputs`.

### 2.1 Observed tool input schemas (all `additionalProperties: false`)

| Tool | Required | Optional (constraints) |
|---|---|---|
| `qloo_recommend` | `target_type` | `signals[1..10]`, `signal_tags[1..10]`, `signal_tags_operator` (union\|intersection), `signal_location`, `demographic`, `filter_location`, `include_tags[1..10]`, `include_tags_operator`, `exclude_tags[1..10]`, `exclude_tags_operator`, `explain` (default true), `limit` 1–20 (default 10) |
| `qloo_rank` | `options[1..10]`, `option_type` | `signals[1..10]`, `signal_location`, `demographic`, `include_tags`, `exclude_tags` |
| `qloo_describe` | `entity` (name or UUID) | `type` |
| `qloo_where_popular` | `entity`, `within` | `entity_type`, `limit` 1–20 |
| `qloo_compare_audiences` | `group_a[1..10]`, `group_b[1..10]` | `target_type`, `limit` 1–20 |
| `qloo_entity_tags` | `entities[1..10]` | `entity_type`, `limit` 1–20 |
| `qloo_audience_demographics` | `entity` | `entity_type`, `limit` 1–20 |
| `qloo_trends` | `entities[1..5]`, `entity_type`, `start_date`, `end_date` (YYYY-MM-DD) | `limit` 1–20 |
| `qloo_find_tags` | `query` | `semantic` (default true), `limit` 1–20 |

**Type tokens.** Workflow inputs use **short names**: `artist, book, brand, movie, person, place, podcast, tv_show, videogame`. Name-resolving tools additionally accept `locality, actor, album, author, director`. Outputs use URNs, for example `urn:entity:book`, `urn:entity:videogame` (not `video_game`), and `urn:entity:author`.

---

## 3. Live call ledger (20 calls)

| Case | Interface → workflow / endpoint | Input summary | Outcome | Harness `duration_ms` |
|---|---|---|---|---|
| LC-1 | `qloo api search` → `/search` | "Agatha Christie", type book, take 3 | ok, 3 books | — (wall 2.8 s) |
| LC-2 | `exec find_tags` → `/v2/tags` | "cozy mystery", limit 5 | ok, 5 tags | 3733 |
| LC-3 | `exec describe` → `/search` + `/entities` | "Murder on the Orient Express", type book | ok, exact match + 4 alternatives | 4860 |
| LC-4 | `exec entity_tags` → `/v2/insights` | canonical Poirot #10 book | ok, 8 tags | 3228 |
| LC-5a | `exec recommend` → `/v2/insights` | book signal → movie | ok, 8 movies | 4022 |
| LC-5b | `exec recommend` → `/v2/insights` | book signal + cozy-mystery tag → artist | ok, 8 artists | 11455 |
| LC-6 | `exec rank` → `/v2/insights` | 3 movies vs book signal | ok, 3 ranked | 3054 |
| LC-7 | `exec compare_audiences` → `/v2/analysis/compare` | book vs artist, target book | ok | 2916 |
| LC-8 | `exec where_popular` → `/v2/insights` | book within "Lisbon" | ok, 5 areas | 12545 |
| LC-9 | `exec trends` | book, 2026-07-27 → 2026-10-19 | **error `QLOO_CONTRACT`** | — |
| LC-9b | `exec trends` → `/v2/trending` | artist, 2026-06-01 → 2026-08-31 | ok, **0 points** | 3150 |
| LC-9c | `exec trends` | book, 2026-06-01 → 2026-08-31 | **error `QLOO_CONTRACT`** | — |
| LC-9d | `exec trends` → `/v2/trending` | movie, 2025-01-06 → 2025-06-30 | ok, 10 points | 3970 |
| LC-10 | `exec audience_demographics` → `/v2/insights` | book | ok | 2667 |
| LC-11 | `exec find_tags` with an isolated empty harness home and a deliberately invalid key | — | **error `QLOO_AUTH`**, exit 4 | — |
| LC-12 | MCP `tools/call qloo_find_tags` | same input as LC-2 | ok, identical results | 2842 |
| LC-13 | `exec describe` | "Lisbon", type locality | **`needs_input`** (4 candidates) | 2441 |
| LC-14 | `exec describe` | "Agatha Christie", no type | **`needs_input`** (4 candidates) | 2205 |
| LC-15 | `qloo api search` → `/search` | "Lisbon", type locality, take 4 | ok, 4 localities | — (wall 3.3 s) |
| LC-16 | `exec recommend` → `/v2/insights` | legacy `author` entity → book | ok, 5 books | 3139 |

Observed harness latency: **2.2–12.5 s per call** (median ≈ 3.2 s). No rate-limit error occurred. The event quota and rate limit are **still unknown**.

---

## 4. Observed result contract

### 4.1 Success envelope (`qloo exec` and `qloo mcp`)

Top-level keys observed: `schema_version` (`1.0-preview.1`), `operation`, `status`, `interpretation`, `resolution`, `results` *(or `series` for trends)*, `result_count`, `explainability` (recommend), `provenance`, `query_intent`, `execution`, and `summary` (on `needs_input`).

- `execution`: `transport` (`direct` | `mcp`), `transport_name`, `correlation_id`, `duration_ms`.
- `provenance`: `source` (`Qloo API`), `endpoint`, `transport`, `documentation`, `requests[]` = `{ method: "GET", path, query }`. **This is the exact request record** and is suitable for Tessaloom's request-to-result trace.
- `interpretation`: how each input was resolved: `{ input, entityId|tagId, name, type, match }`, where `match` ∈ `exact`, `identifier` (observed).
- `query_intent`: normalized signals, filters, operators, output, `assumptions[]` (e.g. `explain=true`, `limit=10`), and `unresolved[]`.
- `resolution.provider`: strategy `exact_name_context_or_choice` (entities) and `target_scoped_semantic_search_exact_name_or_choice` (tags), with `uses_model: false` and `fallback: none`.
- `resolution.outcomes[]`: `{ input, status, match, selected, alternatives[], provenance }`.
- **`needs_input`**: `resolution.issues[]` = `{ input, kind: "ambiguous", input_kind, field, scope?, candidates[{ id, name, type, popularity, description? }], provenance }`, `results: []`, and `summary` "Choose the intended Qloo entity."
- CLI and MCP parity (LC-12): identical keys, status, count, and result order. Only `execution.transport` and `provenance.transport` differ.

### 4.2 Error output (different shape)

On failure, `qloo exec` prints **only** `{ error, operation, correlation_id }`. There is **no** `status`, `execution`, or `provenance` key. The process exits non-zero:

| Code | Observed exit | Retryable | Seen in |
|---|---|---|---|
| `QLOO_AUTH` | 4 | false | LC-11 |
| `QLOO_CONTRACT` | 1 | false | LC-9, LC-9c |

`error` = `{ code, layer: "qloo", retryable, recovery }`. No credential or request detail appeared on stdout or stderr.

### 4.3 Item shapes

| Workflow | Item fields observed |
|---|---|
| `qloo api search` (raw) | Top-level **array**. `{ name, entity_id, types[], properties{…}, popularity, disambiguation, tags[{ name, tag_id, type, value }] }`. Book properties include `description`, `short_description(s)`, `image.url`, `isbn10/13`, `publication_year`, `external.goodreads`. Localities include `admin_level`, `akas`, `ancestors`, `boundaries`, `place`, `population`. |
| `find_tags` | `{ id (tag URN), name, type (tag type URN), popularity }` |
| `describe` | `{ entity_id, name, popularity, properties{ description, short_description, image } }` |
| `entity_tags` | `{ id, name, type, popularity, affinity }` |
| `recommend` / `rank` | `{ entity_id, name, type: "urn:entity", subtype: "urn:entity:<kind>", popularity, affinity, explainability?, properties{…} }`. **The category is in `subtype`.** |
| recommend `explainability` | Per result: `{ "signal.interests.entities": [{ entity_id, score }] }`. Top level: `effect_on_top{3,5,10}_recs` / `effect_on_all_recs` with `avg_score`. Uninformative with a single signal (score 1). |
| `compare_audiences` | `results` is an **object**: `{ tags[], a[], b[], matchEntities[] }`. Items in `a`/`b`: `{ tag_id, name, type, subtype, entity_id, popularity, query{ count } }`. There is no similarity score. LC-7 returned 20 per group although `limit: 5` was requested. |
| `where_popular` | `{ location{ latitude, longitude, geohash }, query{ affinity, affinity_rank, popularity, entity_<kind>_affinity, entity_<kind>_affinity_rank } }`. Sub-city geohash cells (6 characters); **no area names**. |
| `audience_demographics` | `{ entity_id, query{ age{ 24_and_younger, 25_to_29, 30_to_34, 35_to_44, 45_to_54, 55_and_older }, gender{ male, female } } }`. Values are relative indices in [−1, 1], not percentages. |
| `trends` | `series[{ entity{…interpretation}, points[{ date, population_percentile, population_rank (string), population_rank_velocity, velocity_fold_change, population_percent_delta }] }]`. Dates descend; `limit` caps the number of points. |

---

## 5. Capability verdicts

| Capability (API_CONTRACTS §5.4) | Verdict | Evidence |
|---|---|---|
| Cultural entity search | ✅ **CONFIRMED** (via `qloo api search`, not a workflow) | LC-1, LC-15 |
| Identification and disambiguation | ✅ **CONFIRMED, with caveats** | LC-3, LC-13, LC-14, LC-15 |
| Tags and classifications | ✅ **CONFIRMED** | LC-2, LC-4 |
| Cross-domain insights / recommendations | ✅ **CONFIRMED** (signals, tag signals, cross-type targets, affinity, explainability) | LC-5a, LC-5b, LC-16 |
| Shortlist ranking | ✅ **CONFIRMED** | LC-6 |
| Audience comparison | 🟨 **PARTIAL**: works, but returns per-group tag profiles plus overlap lists, not a similarity score; `limit` not honored | LC-7 |
| Location insights | 🟨 **PARTIAL**: within-locality geohash affinity cells, no area names | LC-8 |
| Audience demographics | ✅ **CONFIRMED** (aggregate relative indices) | LC-10 |
| Trends | 🟨 **PARTIAL**: works for `movie` (2025 window). `book` is rejected (`QLOO_CONTRACT`, twice). `artist` returned 0 points for a 2026 window. | LC-9…9d |
| Error and auth handling | ✅ **CONFIRMED** (`QLOO_AUTH`, `QLOO_CONTRACT`, distinct error shape, non-zero exit) | LC-9, LC-11 |
| MCP and CLI parity | ✅ **CONFIRMED** | LC-12 |
| Rate-limit error code, quota, credential expiry | ⛔ **UNKNOWN** (not observed; not published to us) | — |

---

## 6. Findings that change Tessaloom's design

1. **"Exact" resolution can choose the wrong entity.** For "Murder on the Orient Express" (type book), `describe` selected an edition with popularity 0.21. The canonical *Hercule Poirot #10* entity (popularity ≈ 0.999) appeared only in `alternatives`. → Never auto-accept on `match: "exact"` alone. Show the selected entity plus its alternatives at gate H2, sorted by popularity and with descriptions, and preserve all of it as resolution provenance.
2. **The same name spans several entity types.** "Agatha Christie" without a type returned `author` (legacy type), `book` (a biography), `artist`, and `person`. → H2 must show the type for every candidate. Name-only search on a typed query still returns topical matches (LC-1 returned books *about* Christie, not her novels).
3. **Locality candidates need `/search` disambiguation.** `describe` returned four candidates all named "Lisbon", with no description. `qloo api search --type locality` returns a usable `disambiguation` string (e.g. "Lisboa, Lisboa, Portugal" vs. "Lisbon, …, Connecticut, United States of America").
4. **Legacy `author` IDs work as signals** (LC-16 ok), contrary to the docs' "search-only" note. Accept them and label them as legacy types.
5. **One concept maps to many tags.** "cozy mystery" returned five tag URNs across `subgenre:qloo`, `genre:media`, `keyword:media`, `plot:qloo`, `interests:qloo`. → Tag choice also goes through H2. Record the chosen tag type.
6. **Entity tags are noisy.** A train-mystery novel's top tags included "new york city" and an `endorsement:qloo` brand tag. → `TAG_RESONANCE` must use a tag-type allowlist (genre, subgenre, keyword, plot, theme, style) and exclude endorsement tags.
7. **Cross-domain affinity has limited face validity for single seeds.** One book → movies yielded mostly social-issue documentaries with flat affinities (0.883–0.899). Book + cozy-mystery tag → artists yielded mainly French rap/Afropop artists. These are genuine Qloo outputs, but they are aggregate audience affinities and not validated creative fit. → Collision queries should combine ≥ 2 signals and/or tag filters. The UI must label results as aggregate affinity. Evaluator thresholds must consider affinity *spread*, not only presence.
8. **Recommend `type` is generic.** The category is in `subtype`. Normalizers must read `subtype`.
9. **Audience comparison has no score.** `AUDIENCE_BRIDGE` must be redefined around shared `tags` / `matchEntities` and overlap of tag subtypes between `a` and `b`.
10. **Where-popular is intra-city.** `LOCATION_FIT` must be redefined. Given a venue locality, it measures the affinity of the concept's anchor entity in geohash cells within it (optionally near the venue). It does not answer "is it popular in this city".
11. **Trends coverage is type- and window-dependent.** `MOMENTUM` is limited to types and windows that return points. An empty `points` array must yield `INSUFFICIENT`, never a negative stance.
12. **Two output shapes plus exit codes.** The adapter must parse both the result envelope and the bare error object, and map exit codes 1 and 4.
13. **The deployed worker must receive the endpoint variables.** `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` are required for the hackathon endpoint, but the M0 supervisor's worker allowlist (ADR-017) does not forward them. This is an M2 prerequisite (DECISIONS ADR-019).

---

## 7. What V1 does not establish

- The event quota, rate limits, the rate-limit error code, and credential expiry.
- Whether storing and replaying Qloo responses is permitted (R-08). Until then, nothing raw is committed.
- Latency under load, and behavior with ≥ 3 signals, demographic or location signals in `recommend`, or `filter_location`. None were exercised, to conserve budget.
- Statistical validity of any cultural conclusion. V1 checked structures and behaviors only.
