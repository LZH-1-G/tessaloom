# Tessaloom — Test Plan and Acceptance Criteria

> **Status:** v1.1 · 2026-10-20 (review: supervisor and LLM-fallback tests, LLM live checks) · **No tests have been executed yet.** The application code does not exist.
> **Rule:** Results are recorded only after execution, with evidence (CI run URL, log excerpt, or screenshot). Live Qloo results in particular are **never** assumed. Every live-dependent test remains **PENDING LIVE VALIDATION** until it runs with the real credential.
> **Related:** [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) · [API_CONTRACTS.md](API_CONTRACTS.md) · [SECURITY.md](SECURITY.md) · [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)

---

## 1. Strategy

| Principle | Practice |
|---|---|
| Test the mechanism, not the model | Deterministic code (evaluators, scoring, metrics, state machine, keys) is tested exhaustively. LLM-dependent steps are tested through a **scripted LLM double** (`ScriptedLlmProvider`) that returns recorded or hand-written outputs, including invalid ones. |
| Honest Qloo testing | Before the key arrives: adapter tests use **labeled fixtures** and test *our* handling (envelope mapping, errors, caching, provenance). After the key arrives: **live contract tests** record real envelopes, which become contract fixtures with `dataOrigin: REPLAY`. Fixture-based passes are never reported as Qloo validation. |
| Real database | Integration tests run against real PostgreSQL (a Docker service in CI, docker-compose locally). The database is not mocked. |
| Fast feedback | Unit tests < 30 s; integration tests < 3 min; E2E (fixture mode) < 6 min in CI |
| Evidence of completion | A requirement is "done" only when its acceptance test passes in CI (or its manual check is recorded in §15 with evidence) |

---

## 2. Test levels, tools, and environments

| Level | Tool | Scope | Runs in |
|---|---|---|---|
| Unit | Vitest | `core`, `agent`, `qloo-adapter` (normalizers, mapping), `llm-gateway` (validation, repair) | Every push |
| Integration | Vitest + PostgreSQL 16 service | `db` repositories, transactions, worker step commits, API route handlers (via `next` test server or handler invocation) | Every push |
| Contract (fixture) | Vitest | `QlooPort` against `FixtureTransport` + recorded envelopes | Every push |
| Contract (live) | Vitest, `QLOO_MODE=live` | `QlooPort` against `HarnessMcpTransport` / `HarnessCliTransport` with the real key | Manual `workflow_dispatch` (protected environment) + locally by the owner |
| E2E | Playwright (Chromium; WebKit for the smoke subset) | Full app in fixture mode, plus scripted LLM | Every PR / push to main |
| Accessibility | `@axe-core/playwright` | Every page and key state | With E2E |
| Smoke (deployed) | Playwright against the public URL + `curl` health checks | Post-deploy | Deploy workflow + manually before submission |
| Security | gitleaks, `pnpm audit`, OSV-Scanner, CodeQL, header assertions, bundle secret grep | Repo + build | Every push; full-history gitleaks before going public |

**Environments:**

| `APP_ENV` | `QLOO_MODE` | LLM | Data |
|---|---|---|---|
| `test` | `fixture` | `scripted` | Ephemeral DB per test file (schema per worker) |
| `development` | `fixture` (default) or `live` | `scripted` or real | Local docker-compose |
| `staging` (optional) | `live` | Real | Separate DB |
| `production` | `live` only (enforced) | Real | Production DB |

---

## 3. Unit tests (selected cases)

| Area | Cases |
|---|---|
| Experiment key | The same definition with keys in a different order gives the same key (JCS). Any version change gives a different key. Seed order is normalized. A 64-character lowercase hex golden vector is checked. |
| Request hash | Stable across argument key order; includes `harnessVersion` |
| Evaluators (each test kind) | SUPPORTS / CONTRADICTS / NEUTRAL / INSUFFICIENT boundaries; `FIELD_UNAVAILABLE` when a needed field is missing; ruleset version stamped |
| Hypothesis status | Each status rule in AGENT_WORKFLOW §12, table-driven, including edge cases (0 tested claims, all errors) |
| Scores | Support formula; novelty with and without tags (`REDUCED_INPUTS` flag); feasibility rules; composite weights sum validation; range 0–100 |
| Collision pool | Bridge detection; tension fit; MMR diversity (no duplicate domain pair); deterministic output for a fixed input |
| Comparison metrics | overlap@K (identical → 1, disjoint → 0); RBO against reference values from the paper's examples; entered/exited sets; drift index |
| Delta planner | Seed swap marks exactly the queries whose `dependsOn` includes the seed; a weights-only delta gives 0 dirty queries; a location delta affects only location-dependent queries |
| Budget guard | Pre-check blocks the call that would exceed the limit; trimming keeps priority claims |
| Validators | Grounding rejects unknown entity IDs; citation rejects unknown evidence IDs; numeric fidelity catches a changed number; stance integrity rejects upgrades; safe-use flags individual-level phrasing |
| Envelope mapping | Every `status` value maps correctly (API_CONTRACTS §5.2); a missing status maps to `UNKNOWN_ENVELOPE`; `error` is present only for the error status |
| Log redaction | Secrets in nested objects and headers are redacted |
| Env schemas | The web env rejects `QLOO_API_KEY`; the worker env requires it in live mode; production + fixture mode is rejected |

**Coverage targets:** ≥ 85% lines for `core` and `agent`; ≥ 75% for `qloo-adapter` and `llm-gateway`. Coverage is a guide; untested branches in evaluators are not acceptable.

---

## 4. Agent state transition tests

1. **Transition table completeness.** For every `(state, event)` pair: allowed pairs produce the declared next state, and disallowed pairs throw `IllegalTransition`. This is generated from the table, giving 100% pair coverage.
2. **Guards.** Each guard is tested true and false (for example, H2 confirmation needs ≥ 2 seeds in ≥ 2 domains).
3. **Run-kind entry points.** QUEUED → the correct first state for each of the 4 kinds.
4. **Termination.** Scripted scenarios hit each termination rule: convergence, diminishing returns, iteration limit, and budget (`COMPLETED_WITH_LIMITS` with the correct `terminalReason`).
5. **Global events.** `CANCEL`, `BUDGET_EXHAUSTED`, and `FATAL_ERROR` from every non-terminal state.
6. **Persistence.** Integration test: run a full EXPLORATION with the scripted LLM and fixture Qloo. Assert one `state_version` increment per step, contiguous `run_events.seq`, and that every committed step's records exist.
7. **Idempotency.** Deliver the same `run.step` job twice → the second is a no-op. A stale `expectedStateVersion` is acknowledged without changes.
8. **Crash recovery.** Kill the worker between the external call and the commit (fault injection hook) → on retry, the step re-executes and exactly one commit occurs. The quota counter includes both attempts.
9. **Cancellation.** Cancel during COLLECTING_EVIDENCE → the in-flight call is aborted, the state becomes CANCELLED, partial records are kept and labeled, and no further jobs are enqueued.
10. **Paused expiry.** A run awaiting confirmation for more than 24 h → CANCELLED (`EXPIRED`) by the maintenance job.
11. **Human gates.** A confirmation with the wrong `kind` or for a non-paused run → 409 `STATE_CONFLICT`.

---

## 5. Qloo adapter contract tests

### 5.1 Fixture contract tests (pre-key; run on every push)

| Test | Assertion |
|---|---|
| Fixture labeling | Every fixture file has `_fixture.synthetic = true` and the label text. Entity IDs start with `fixture-`. |
| Provenance | Outcomes from `FixtureTransport` have `dataOrigin: FIXTURE` and `transport: FIXTURE`. Persisted records are `DEVELOPMENT_FIXTURE`. |
| Missing fixture | An unknown request hash → `ERROR FIXTURE_MISSING`, never "closest match" data |
| No fallback path | A live transport configured with a failing child process returns ERROR. Spying shows `FixtureTransport` is never invoked. A static import-boundary lint passes. |
| Production guard | Constructing `FixtureTransport` with `APP_ENV=production` throws |
| Envelope statuses | Hand-written envelopes for `ok`, `empty`, `needs_input`, `partial`, `degraded`, `error` (retryable and not), and malformed input → correct `QlooOutcome` |
| Cache | Second identical call → `dataOrigin: CACHE`, `cache_source_invocation_id` set, no transport call; TTL expiry → transport called again |
| Rate limiter | 21 calls in a minute with a 20/min limit → the 21st waits (fake timers); concurrency never exceeds 2 |
| Quota guard | The counter at the cap refuses the call with `QUOTA_GUARD_ACTIVE` **before** calling the transport |
| Argument validation | Out-of-range `limit` (0 or 21 for find_tags), > 5 signals, an unresolved entity → rejected before the transport |

### 5.2 Live contract tests (executed in V1 on 2026-10-21; rerun for M2 contract tests)

These run with `QLOO_MODE=live` and the real key. Each test **records** the redacted request and the full envelope to `fixtures/qloo-recorded/` (with `dataOrigin: REPLAY` metadata and a retrieval timestamp). It asserts only **structural** expectations, never specific cultural results.

| ID | Capability | Steps | Structural assertions | Status |
|---|---|---|---|---|
| LC-0 | Harness readiness | Start `qloo mcp`; `listTools()`; `qloo_capabilities` | The tool list contains the expected names; `adapter.ready === true`. Save the tool input schemas to `docs/research/qloo-tools.json` (redacted). | **Executed 2026-10-21 — PASS.** 10 tools; `qloo_capabilities` contract 1.0.0 / result schema 1.0-preview.1. Schemas are summarized in research/QLOO_V1_VALIDATION.md §2.1 (not saved as raw JSON). |
| LC-1 | Entity search | `qloo api search --query "<known author>" --take 3 --json` | `success`/results shape; each item has an ID and name field (names recorded) | **Executed — PASS.** Top-level array of `{ name, entity_id, types[], properties, popularity, disambiguation, tags[] }`; endpoint verified as `hackathon.api.qloo.com/search`. |
| LC-2 | Find tags | `qloo_find_tags { query: "cozy mystery", limit: 5 }` | `status ∈ {ok, empty, needs_input}`; item fields recorded | **Executed — PASS.** `ok`, 5 tags `{ id, name, type, popularity }` spanning 5 tag types. |
| LC-3 | Describe | `qloo_describe` with an ID from LC-1 | Returned ID equals the requested ID (or document the actual behavior) | **Executed — PASS, with a finding.** Name resolution `match: exact` chose a low-popularity edition; the canonical entity was in `alternatives`. LC-13/14 added `needs_input` coverage. |
| LC-4 | Entity tags | `qloo_entity_tags` with an ID from LC-1 | Tag item shape recorded | **Executed — PASS.** `{ id, name, type, popularity, affinity }`; noisy tag types observed. |
| LC-5 | Recommend | `qloo_recommend { signals: [LC-1 id], target_type: <movie type token> }` | Result count > 0 or `empty`; record the affinity/popularity field presence | **Executed — PASS** (LC-5a book→movie; LC-5b +tag→artist; LC-16 legacy author→book). Category in `subtype`; `affinity` and `explainability` present. |
| LC-6 | Rank | `qloo_rank` with 3 options | Ordered output recorded | **Executed — PASS.** Ordered by affinity. |
| LC-7 | Compare audiences | `qloo_compare_audiences` with two IDs | Output fields recorded | **Executed — PARTIAL.** `results{ tags[], a[], b[], matchEntities[] }`, no score; `limit` not honored. |
| LC-8 | Where popular | `qloo_where_popular { entity, within: "<city>" }` | Output shape recorded | **Executed — PARTIAL.** Intra-city geohash cells with affinity; no area names. |
| LC-9 | Trends | `qloo_trends` with 1 entity, 12 weeks | Trend fields recorded | **Executed — PARTIAL.** `book` → `QLOO_CONTRACT` (×2); 2026 `artist` window → 0 points; 2025 `movie` window → 10 points with the documented fields (LC-9b/c/d). |
| LC-10 | Demographics | `qloo_audience_demographics` with 1 entity | Output shape recorded | **Executed — PASS.** `query{ age{6 bands}, gender }` relative indices. |
| LC-11 | Auth failure | Run with an invalid key in an isolated env | `status: error`, `error.code: QLOO_AUTH`, `retryable: false` | **Executed — PASS.** Bare error object, `QLOO_AUTH`, `retryable: false`, exit 4; nothing leaked. |
| LC-12 | CLI parity | `qloo exec find_tags --input-file` vs MCP `qloo_find_tags` with the same input | Same envelope shape (per kit) | **Executed — PASS.** Identical keys, status, and result order; only `transport` differs (`direct` vs `mcp`). |

After LC-0…LC-10, the normalizers are updated and the evaluator thresholds for `AUDIENCE_BRIDGE` and `MOMENTUM` are calibrated (decision recorded in DECISIONS.md). **Budget for the live contract suite: ≤ 25 Qloo calls per full run.**

### 5.3 LLM provider live checks (**PENDING**: these require the owner's Claude API key; not run in CI)

| ID | Check | Assertion | Status |
|---|---|---|---|
| LM-1 | `GET /v1/models/claude-opus-5-5` and `GET /v1/models/claude-sonnet-5-5` with the owner's key | Both return 200, so the account can access the models documented on 2026-10-20 | Not executed |
| LM-2 | One minimal structured-output call per model (an R1 `IntentFrame` for a fixture brief) | Parses against the Zod schema; usage recorded; cost matches the price table | Not executed |
| LM-3 | Forced fallback (`LLM_MODE=economy`) | The step runs on `claude-sonnet-5-5`; `fallback_used = true` | Not executed |

LM checks cost well under $0.50 in total (ADR-018 prices). They are run by the owner and logged in §15.

---

## 6. Schema validation tests

- **Round trip.** Every Zod schema in `core` round-trips (parse → serialize → parse) on property-based generated data (fast-check), and rejects known-invalid samples.
- **JSON Schema export.** The Zod → JSON Schema export used for LLM structured outputs is snapshot-tested. Each role's exported schema stays within provider limits (no unsupported keywords), checked by a provider-specific lint.
- **API contracts.** Every route handler test validates the response body against the response schema.
- **Database JSON columns.** Repository writes reject invalid JSON payloads (integration).
- **Migrations.** CI applies all migrations to an empty database and runs `drizzle-kit check` (no drift).

---

## 7. Provenance and reproducibility verification

### 7.1 Evidence provenance

| Test | Assertion |
|---|---|
| Pointer verification | For each evidence fact: `snapshot.raw` at `jsonPointer` deep-equals `value` (integration test over a full fixture run) |
| DB constraint | Inserting `QLOO_SOURCED` evidence without `tool_invocation_id` fails |
| Fixture coupling | Evidence from a FIXTURE invocation must be `DEVELOPMENT_FIXTURE`; otherwise the insert fails (trigger or service check) |
| Graph projection | Every graph node and edge carries a provenance class; `QLOO_SOURCED` nodes link to ≥ 1 invocation |
| Blueprint traceability | Every block has a provenance; every cited evidence ID exists in the experiment; the traceability report counts match the blocks |
| UI labeling (E2E) | Every evidence item, hypothesis card, and blueprint block shows a provenance chip (DOM query: elements with `data-provenance` attributes = number of fact elements) |

### 7.2 Counterfactual reproducibility

| Test | Assertion |
|---|---|
| Deterministic key | Branching twice with an identical delta → the same `experiment_key` → the existing branch is returned (`reused: true`) |
| Dirty set correctness | For scripted plans: seed swap, domain add, weights-only, constraint-only, and location deltas each produce the exact expected dirty/reused sets |
| Genuine recomputation | With fixtures where the branch's recommend results differ from the parent's: the comparison shows the expected `entered`/`exited`, stance changes, and `newQlooResults > 0` |
| Rescore-only honesty | A weights-only delta → `dirtyQueries = 0`, the UI label "no new Qloo data", and the narrative contains no claim of new data (template check) |
| Replay exactness | Replaying an experiment from stored snapshots and LLM outputs gives byte-identical hypotheses, evidence, scores, and comparison metrics (hash comparison) |
| Re-evaluation determinism | Changing the ruleset version and re-evaluating gives the same result twice |
| Live revalidation (PENDING LIVE) | A REVALIDATION run on a live experiment produces a DATA_DRIFT comparison whose metrics are computed from the new invocations. The drift value is reported, not asserted. |

---

## 8. Failure-mode tests

| Failure | Injection method | Expected behavior |
|---|---|---|
| Qloo auth failure | Fixture envelope `error QLOO_AUTH retryable:false`; live LC-11 | No retry; the run FAILS with `QLOO_UNAVAILABLE`; UI banner; no fixture fallback |
| Qloo rate limiting | Fixture error with a rate-limit code (the exact code is PENDING; simulated `QLOO_RATE_LIMIT`) + limiter fake timers | Backoff 5 s / 15 s; claims INCONCLUSIVE; ≥ 50% rate-limited → `COMPLETED_WITH_LIMITS (RATE_LIMITED)` |
| Network timeout | Transport stub that never resolves; 30 s timeout with fake timers | 1 retry, then the claim is INCONCLUSIVE (`TIMEOUT`); the run continues |
| Harness child crash | Kill the child process mid-call | Restart with backoff; CLI fallback for the call; after 3 crashes in 60 s, the run FAILS (`QLOO_TRANSPORT_DOWN`) |
| `needs_input` during evidence | Fixture | Claim INCONCLUSIVE (`AMBIGUOUS_INPUT`) |
| `partial` / `degraded` | Fixture | Evidence quality flag stored and displayed |
| LLM invalid JSON / schema mismatch | `ScriptedLlmProvider` returns an invalid object, then a valid one | One repair attempt succeeds; `llm_invocations` has INVALID → REPAIRED |
| LLM invalid twice | Scripted invalid ×2 | The run FAILS `LLM_INVALID_OUTPUT`; the invalid output is stored; the UI shows the retry option |
| LLM ungrounded entity | Scripted output referencing an unknown entity ID | Grounding validator → repair; still invalid → the element is dropped and logged |
| LLM fabricated number | Narrative with a number not in the metrics | Numeric fidelity → repair; fallback to the deterministic template |
| LLM refusal | Scripted `stop_reason: refusal` | No loop retry; the run FAILS with a neutral message |
| LLM truncation | Scripted `max_tokens` | One retry with a higher cap if within budget |
| DB unavailable mid-commit | Kill the DB connection in the transaction | Rollback; job retry; no partial commit (integration) |
| Concurrent confirmation | Two confirmation POSTs at the same time | Exactly one succeeds; the other gets 409 |
| Blueprint edit conflict | Two saves with the same `baseRevisionId` | The second gets 409 |
| SSE disconnect | Drop the connection in Playwright | The client reconnects with `Last-Event-ID`; no duplicate or missing events |
| Budget exhaustion | Set `maxQlooCalls = 5` | Trimmed plan; `UNTESTED_BUDGET` claims; `COMPLETED_WITH_LIMITS` |
| LLM primary unavailable | Scripted provider returns overloaded/5xx for the primary model | The whole step reruns on `LLM_FALLBACK_MODEL`; `llm_invocations.fallback_used = true`; `model_id` = the fallback; no mid-conversation switch |
| Cost budget nearly exhausted | Remaining USD below the primary's estimate but above the fallback's | The step uses the fallback; if neither fits → `COMPLETED_WITH_LIMITS` |
| Worker process crash (single container) | Container smoke: `kill -9` the worker PID | The supervisor restarts the worker within 5 s; the heartbeat resumes; the in-flight run resumes from its last commit; the web keeps serving |
| Repeated crashes | Force the worker to exit on start 6 times | The supervisor exits with code 1 after more than 5 crashes in 5 minutes (the platform restarts the container) |
| Stale worker heartbeat | Pause the worker (SIGSTOP) for 35 s | `/api/health/ready` returns 503 (platform health check fails) |

---

## 9. Security checks

| Check | Method | Pass criterion |
|---|---|---|
| Secret scanning | gitleaks (CI each push; full history before going public) | 0 findings |
| Bundle secret grep | CI: build web, grep `.next/` for env values and the `QLOO_API_KEY` / `API_KEY` names | 0 matches |
| Web env deny-list | Unit test | The web boot fails if `QLOO_API_KEY` or `ANTHROPIC_API_KEY` is set |
| Cross-workspace access | Integration: workspace B requests every resource of workspace A | 404 everywhere |
| Share scope | Integration + E2E: a blueprint-scoped token cannot read other experiments; mutations fail | 403/404 |
| Share revocation/expiry | Integration | Revoked or expired → "no longer active" |
| CSRF | Integration: mutation without the header or with a foreign Origin | 403 `CSRF_FAILED` |
| Headers and CSP | Playwright response assertions on all pages | All headers present |
| XSS | E2E: a brief title and a note containing `<img src=x onerror=alert(1)>` | Rendered as text; no dialog fires |
| Command injection | Unit: CLI transport with a malicious argument (`; rm -rf`) | Rejected by the allowlist; `execFile` never uses a shell |
| Rate limiting | Integration: 7 run starts per minute | The 7th returns 429 |
| Dependency audit | `pnpm audit --prod`, OSV-Scanner | No high or critical without a documented exception |
| Static analysis | CodeQL (JavaScript/TypeScript) | No high-severity alerts |
| Fixture firewall | Integration: production config + fixture mode | Boot fails; the serializer blocks fixture records |
| Supervisor env allowlists | Unit: `buildChildEnv('web', fullEnv)` / `buildChildEnv('worker', fullEnv)` | The web env has no `QLOO_*` secrets, no `*_API_KEY`, no `DATABASE_URL_MIGRATOR`; the worker env has no `SESSION_SECRET`, `SHARE_TOKEN_PEPPER`, or migrator URL; unknown variables are dropped |
| Web process env in a running container | Container smoke (CI `docker` job): start the image with dummy secret values; read `/proc/<web-pid>/environ` | No `QLOO_API_KEY` / `ANTHROPIC_API_KEY` present |
| UID separation (when a root start is used) | Container smoke: `ps -o user,pid,cmd` | web runs as `tl-web`, worker as `tl-worker`; `QLOO_HOME` is mode `0700`, owned by `tl-worker` |
| Supervisor logging | Unit | Startup logs list variable names only; no values |

---

## 10. Browser end-to-end and accessibility tests (Playwright)

Run in fixture mode with the scripted LLM. The **FIXTURE banner must be visible in every E2E test**, and that is asserted.

| ID | Journey | Key assertions |
|---|---|---|
| E2E-01 | Dashboard → fork sample → Hypothesis Lab | Cards render with status, scores, provenance chips; the REPLAY badge is visible |
| E2E-02 | New project → brief → H1 confirm | Validation errors for < 2 interests; the IntentFrame chips are editable |
| E2E-03 | H2 entity confirmation | Ambiguous interest shows candidates; refine and exclude work |
| E2E-04 | Discovery canvas | Lanes render; the tension slider changes the selected pool; the List view is equivalent |
| E2E-05 | Hypothesis loop live view | The activity dock streams events in order; budget meters update; final hypotheses show stances |
| E2E-06 | Evidence drawer + trace | Trace shows the redacted request, envelope status, pointer value, evaluator rule |
| E2E-07 | What-if seed swap | Preview counts are shown; branch runs; the comparison shows entered/exited items and stance changes |
| E2E-08 | What-if weights only | "No new Qloo data" label; dirty = 0 |
| E2E-09 | Blueprint compose + edit + export | Traceability meter; citations open evidence; an edit creates revision 2; Markdown export contains the evidence appendix |
| E2E-10 | Share link | Read-only view renders; no controls; revoke → inactive |
| E2E-11 | Cancel a run | State CANCELLED; partial results ribbon |
| E2E-12 | Error states | Quota guard banner; worker offline banner (heartbeat stubbed stale) |
| E2E-13 | Mobile viewport (390×844) | No horizontal page scroll; the graph defaults to the list view; the dock is a sheet |
| A11Y-01 | axe-core on all 8 pages × key states | 0 serious or critical violations |
| A11Y-02 | Keyboard-only full journey (E2E-02 → E2E-09) | Completes without a mouse; focus is always visible |
| A11Y-03 | Reduced motion | Animations disabled when `prefers-reduced-motion` is set |
| A11Y-04 | Color contrast tokens | An automated check over the token pairs passes AA |

---

## 11. Representative scenarios

Each scenario is run three ways:

- **(a) fixture mode** in CI, with synthetic fixtures named after fictional entities to avoid implying real Qloo results;
- **(b) live mode** by the owner after the key arrives, **PENDING LIVE VALIDATION**;
- **(c) replay mode** of the recorded live run, used for the sample projects.

The **expected behaviors** below are mechanism checks. **Expected cultural results are deliberately not specified**, because they are unknown until live execution.

### Scenario S1 — "Midnight Margins" (independent bookstore)

- **Brief:** A 60-capacity bookstore wants a late-evening event that attracts people aged 25–40 who rarely visit bookstores.
- **Interests:** a contemporary Japanese literary novelist; Japanese city-pop music; Nordic noir TV dramas.
- **Expected behaviors:**
  1. H1 shows 3 interests with guessed domains (book/person, artist, tv_show).
  2. Any ambiguous interest triggers H2. For example, "city pop" may resolve to a tag rather than an entity; the user chooses.
  3. Discovery creates threads into ≥ 2 other domains.
  4. ≥ 4 hypotheses, each with 1–3 claims mapped to available test kinds.
  5. The run ends by convergence, diminishing returns, iterations, or budget, and the reason is shown.
  6. **What-if:** swap the Nordic noir seed for a "cozy mystery" tag (hold hypotheses). Dirty queries are exactly those depending on that seed; the comparison reports overlap, RBO, and stance changes.
  7. A blueprint from the top hypothesis has a traceability report, and every Qloo-backed block cites evidence.

### Scenario S2 — "Low-Fi Lounge" (neighborhood café)

- **Brief:** A 35-seat café wants a recurring weekday evening that fits a creative, budget-conscious neighborhood crowd.
- **Interests:** cumbia music; cozy/life-sim video games; specialty coffee culture (likely a tag or brand).
- **Constraints:** low budget, 120-minute duration.
- **Expected behaviors:**
  1. Interests in different entity categories (artist, video game, tag/brand) resolve or ask for confirmation.
  2. The collision tension at "Unexpected" (τ = 0.8) selects a different pool from "Harmonious" (τ = 0.3). This is verified by the pool diff in the UI and the DB.
  3. Feasibility scoring penalizes concepts whose sketches require large capacity (rule-based check against capacity 35).
  4. **What-if:** change the target domains (remove podcast, add tv_show) → only the discovery and evidence queries targeting those domains are dirty.
  5. **What-if:** raise feasibility weight to 0.5 → rescore-only, labeled "no new Qloo data", and the ranking changes deterministically.

### Scenario S3 — "Future Roots" (community library festival)

- **Brief:** A library hall (capacity 120) is planning a Saturday festival segment that bridges a speculative-fiction reading circle and a local music community.
- **Interests:** an Afrofuturist novelist; an experimental jazz artist; community board-gaming.
- **Locality:** the user's city (if `wherePopular` is supported).
- **Expected behaviors:**
  1. `AUDIENCE_BRIDGE` claims call `compareAudiences`. Until thresholds are calibrated live, the stance is INSUFFICIENT with the note "evaluator pending live calibration" (an honest degradation).
  2. `LOCATION_FIT` (if supported) produces location evidence; if unsupported, the claim is UNTESTABLE with an explanation.
  3. **What-if:** swap the jazz artist for a contemporary R&B artist → a parent-vs-branch comparison with per-hypothesis status changes.
  4. **What-if:** change the momentum time window from 12 to 26 weeks → only MOMENTUM queries are dirty.
  5. Exporting the blueprint (Markdown) includes the evidence appendix with retrieval dates and data-origin labels.

---

## 12. Module acceptance criteria

Each criterion has a **measurable** pass condition and the test(s) that prove it. "R" criteria must pass for submission.

### 12.1 Cultural Intelligence

| # | Criterion | Measure | Test |
|---|---|---|---|
| CI-A1 | Ambiguous interests are never auto-resolved | 0 auto-selections when > 1 candidate or a non-exact name (fixture suite of 10 cases) | Unit + E2E-03 |
| CI-A2 | Every Qloo call is recorded | `tool_invocations` count = adapter call count (incl. retries) in a full run | Integration |
| CI-A3 | Every Qloo-sourced fact is pointer-verifiable | 100% of facts pass pointer verification | §7.1 |
| CI-A4 | Cache reuse is labeled | 100% of cache hits have `dataOrigin=CACHE` and a source invocation | §5.1 |
| CI-A5 | Live readiness is visible | `/api/health/qloo` reflects `qloo_capabilities` within 60 s | Integration + LC-0 (live PENDING) |

### 12.2 Cultural Collision Engine

| # | Criterion | Measure | Test |
|---|---|---|---|
| CC-A1 | The pool is deterministic | Same inputs → identical pool (IDs and order) across 10 runs | Unit |
| CC-A2 | Tension changes the pool | τ 0.3 vs 0.8 on the S2 fixture → ≥ 30% of pool members differ | Unit + S2 |
| CC-A3 | Diversity | No two selected candidates share the same domain pair | Unit |
| CC-A4 | Reduced-input honesty | Without tags, every candidate is flagged `REDUCED_INPUTS` and the UI shows it | Unit + E2E-04 |

### 12.3 Creative Hypothesis Lab

| # | Criterion | Measure | Test |
|---|---|---|---|
| HL-A1 | Hypotheses are grounded | 100% of `elementRefs` exist in experiment entities | Validator unit + integration |
| HL-A2 | Stances are deterministic | The same evidence and ruleset → the same stance (100%) | Unit |
| HL-A3 | The critic cannot upgrade | An attempted upgrade is rejected (100%) | Unit |
| HL-A4 | The loop terminates within limits | No run exceeds `maxIterations`, `maxQlooCalls`, `maxLlmCalls`, or wall clock (property test over 50 scripted runs) | Integration |
| HL-A5 | Negative results are kept | Retired or contradicted hypotheses remain queryable and visible | E2E-05 |

### 12.4 Interactive Cultural Evidence Graph

| # | Criterion | Measure | Test |
|---|---|---|---|
| EG-A1 | Provenance is encoded beyond color | Each node type × provenance has a text label and a distinct border style | Visual regression snapshot + axe |
| EG-A2 | Performance | 300 nodes / 600 edges: initial render < 1.5 s and pan/zoom ≥ 30 fps (Playwright trace on CI hardware; reported, warning threshold) | E2E perf |
| EG-A3 | Inspector completeness | Selecting any Qloo node shows ≥ 1 trace link | E2E-06 |
| EG-A4 | Accessible alternative | The List view contains every node and edge in the graph (count equality) | E2E-04 |

### 12.5 What-if Experimentation Simulator

| # | Criterion | Measure | Test |
|---|---|---|---|
| WI-A1 | Only dirty queries are executed | Transport call count = `plannedDirtyQueries` (± retries) for 5 delta types | Integration |
| WI-A2 | Genuineness reporting | 100% of comparisons include dirty/reused/new counts; dirty = 0 → label shown | §7.2 + E2E-08 |
| WI-A3 | Metrics are correct | overlap@K, RBO, entered/exited match hand-computed fixture expectations | Unit |
| WI-A4 | Narrative numeric fidelity | 0 numbers in rendered narratives that are not in the metrics | Validator + E2E-07 |
| WI-A5 | Branch reproducibility | An identical delta → the same key → reused | §7.2 |

### 12.6 Experience Blueprint Composer

| # | Criterion | Measure | Test |
|---|---|---|---|
| EB-A1 | Full traceability labeling | 100% of blocks have a provenance; 100% of citations resolve | §7.1 |
| EB-A2 | Constraints identified | ≥ 1 constraint per blueprint when the brief has a capacity or budget (S1–S3 fixture) | Integration |
| EB-A3 | Revisions are append-only | An edit creates revision n+1; earlier revisions are unchanged (hash) | Integration |
| EB-A4 | Export fidelity | The Markdown export contains every section, every block's provenance label, and an evidence appendix with retrieval dates | Unit + E2E-09 |

### 12.7 Agent Activity Monitor

| # | Criterion | Measure | Test |
|---|---|---|---|
| AM-A1 | Live latency | First event visible ≤ 3 s after run start (fixture mode, CI) | E2E-05 |
| AM-A2 | Ordered and complete | The UI event list equals DB `run_events` (seq contiguous) after the run, including after a reconnect | E2E + SSE test |
| AM-A3 | No chain-of-thought exposure | The event payload schema has no reasoning fields; LLM thinking is never stored (schema test + DB column absence) | Unit |
| AM-A4 | Controls work | Cancel → CANCELLED ≤ 5 s (excluding an in-flight Qloo call timeout) | E2E-11 |

### 12.8 Persistent Project Workspace

| # | Criterion | Measure | Test |
|---|---|---|---|
| PW-A1 | Persistence | Reload the browser → projects, experiments, branches, and blueprints all present | E2E |
| PW-A2 | Isolation | Cross-workspace access returns 404 for all resource types | §9 |
| PW-A3 | Share links | Read-only scope enforced; revoke effective immediately | E2E-10 |
| PW-A4 | Export | The project JSON export validates against `ProjectExportV1` and includes all experiments | Integration |
| PW-A5 | Sample fork | Forking creates an independent copy; edits don't affect the sample | Integration |

---

## 13. Deployment smoke tests

Run after every production deploy, and manually on the day of submission and at least once during the judging window. Results are logged in §15.

1. `GET /api/health` → 200.
2. `GET /api/health/ready` → 200 (DB + worker heartbeat).
3. `GET /api/health/qloo` → `adapterReady: true`, `mode: live` (**PENDING** until the key is configured).
4. Playwright on the public URL (WebKit + Chromium):
   - the dashboard loads in < 3 s;
   - a sample project opens with the REPLAY badge;
   - the evidence drawer opens;
   - a share link of a sample blueprint renders in a private context.
5. A live micro-run (owner-triggered): a minimal brief with 2 known interests and a budget of 6 Qloo calls reaches H2/H3 without error (**PENDING LIVE VALIDATION**).
6. Security headers are present; the fixture banner is **absent**; no `DEVELOPMENT_FIXTURE` data in any API response.

---

## 14. CI pipeline (GitHub Actions)

```
on: [push, pull_request]
jobs:
  lint-typecheck:  pnpm install --frozen-lockfile; pnpm lint; pnpm typecheck
  unit:            pnpm test:unit --coverage
  integration:     services: postgres:16 → pnpm db:migrate; pnpm test:integration
  e2e:             build; start web + worker (fixture, scripted LLM); pnpm test:e2e (+ axe)
  security:        gitleaks; pnpm audit --prod; osv-scanner; bundle-secret-grep
  codeql:          github/codeql-action (javascript-typescript)
  docker:          docker build (verifies harness install + node version); container smoke:
                   run the image (TL_ROLE=all, QLOO_MODE=fixture, scripted LLM, dummy secrets) + postgres →
                   /api/health/ready = 200, web env scrubbed, worker restart test; trivy scan (optional)
workflow_dispatch:
  live-contract:   environment: qloo-live (required reviewer) → pnpm test:contract:live
  smoke:           target URL input → pnpm test:smoke
```

**Required checks for `main`:** `lint-typecheck`, `unit`, `integration`, `e2e`, `security`.

---

## 15. Execution log (to be filled only with real results)

| Date | Test set | Environment | Result | Evidence link | Notes |
|---|---|---|---|---|---|
| 2026-10-21 | M0 review remediation: unit, integration, runtime, browser/a11y, build, security, container smoke | Node 22.23.3, pnpm 10.34.7; local macOS + Docker Linux arm64; PostgreSQL 16 | **Local checks PASSED; PR CI BLOCKED** | [M0 verification](M0_VERIFICATION.md) | 62 unit, 3 integration, 6 runtime, 2 browser tests; live supervised worker environment/UID executes qloo 0.1.26; missing root UID rejected; no commit/push authorization; M1 not started |
| 2026-10-21 | V1 live contract suite LC-0…LC-12 (+ LC-13…LC-16) | `qloo-harness` 0.1.26 → `https://hackathon.api.qloo.com`; local macOS | **20 calls: 15 ok, 2 `needs_input` (expected), 2 `QLOO_CONTRACT` (trends/book), 1 deliberate `QLOO_AUTH`**; the 20 include the LC-9b–d trends follow-ups | [V1 report](research/QLOO_V1_VALIDATION.md) | Raw responses not committed (R-08); quota and rate-limit code unknown |
| 2026-10-21 | M1: unit (core schemas, SHA-256/JCS vectors, golden key, UUIDv7) + PostgreSQL integration (migrations, constraints, triggers, concurrency, repositories) | Node 22.23.3; PostgreSQL 16 (local Docker) | **91 unit / 23 integration PASS**; core 100% lines; `drizzle-kit check` clean; OSV clean (512 packages) | — | Each integration file uses its own migrated database |
