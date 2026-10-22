# Tessaloom — Architecture Decisions, Trade-offs, and Risks

> **Status:** v1.2 · 2026-10-21 (ADR-019 from V1 live validation; earlier: ADR-017, ADR-018) · ADR format: Context → Decision → Alternatives → Consequences
> **Rule:** New decisions are appended with a date. Superseded decisions are marked, not deleted. Never record secrets here.

---

## 1. Decision index

| ADR | Title | Status | Date |
|---|---|---|---|
| ADR-001 | Modular monolith with two processes (web + worker) | Accepted; **deployment topology amended by ADR-017** | 2026-10-20 |
| ADR-002 | Always-on container hosting instead of serverless | Accepted; **"two apps" amended by ADR-017** | 2026-10-20 |
| ADR-003 | Qloo access through the official harness, not direct REST | Accepted | 2026-10-20 |
| ADR-004 | Drizzle ORM instead of Prisma | Accepted | 2026-10-20 |
| ADR-005 | PostgreSQL-backed job queue (pg-boss) | Accepted | 2026-10-20 |
| ADR-006 | Controlled state machine instead of a multi-agent framework | Accepted | 2026-10-20 |
| ADR-007 | The LLM proposes evidence queries; the orchestrator executes them | Accepted | 2026-10-20 |
| ADR-008 | Deterministic evaluators own claim stances | Accepted | 2026-10-20 |
| ADR-009 | Provider-agnostic LLM port; default Anthropic `claude-opus-5-5` | Accepted (model/tier is owner-configurable) | 2026-10-20 |
| ADR-010 | SSE with DB polling for live activity | Accepted | 2026-10-20 |
| ADR-011 | Anonymous cookie workspaces; no accounts | Accepted | 2026-10-20 |
| ADR-012 | UUIDv7 primary keys + JCS/SHA-256 deterministic experiment keys | Accepted | 2026-10-20 |
| ADR-013 | Counterfactuals default to holding hypotheses fixed | Accepted | 2026-10-20 |
| ADR-014 | The fixture firewall | Accepted | 2026-10-20 |
| ADR-015 | REST route handlers for commands; RSC for reads | Accepted | 2026-10-20 |
| ADR-016 | Managed PostgreSQL (default Neon) and Fly.io (default host) | Confirmed engineering target in M0; provisioning remains M10. (Single service per ADR-017.) | 2026-10-21 |
| ADR-017 | **Single deployment service: one container, two supervised processes** | **Accepted** (supersedes the two-app deployment in ADR-001/002) | 2026-10-20 (review) |
| ADR-018 | LLM model verification, configurable fallback model, cost model, and credentials | **Accepted** | 2026-10-20 (review) |
| ADR-019 | V1-observed Qloo contract: endpoint configuration, transports, disambiguation, and evaluator redefinitions | **Accepted** | 2026-10-21 (V1) |
| ADR-020 | M1 data-layer decisions: raw retention off by default, trigger-enforced immutability, pure-TS hashing, esbuild override | **Accepted** | 2026-10-21 (M1) |
| ADR-021 | M2 live Qloo adapter decisions: endpoint variables in the worker, MCP SDK version, routing, local unsupported answers, in-memory cache | **Accepted** | 2026-10-21 (M2) |
| ADR-022 | M3 LLM gateway decisions: dependency direction (injected validators), SDK call shape, typed claim params, prompts in code, policies | **Accepted** | 2026-10-21 (M3) |
| ADR-023 | M4 orchestrator decisions: machine in core, pure step handlers with commit plans, pg-boss topology, grading at collection, worker-published run config, retry and budget termination | **Accepted** | 2026-10-21 (M4) |
| ADR-024 | M5 discovery decisions: V1-based resolution strategy, tag enrichment budget, synthetic fixtures and scripted AI for development/E2E, fixture firewall through the cache, collision engine in core | **Accepted** | 2026-10-21 (M5) |
| ADR-025 | M6 hypothesis-loop decisions: pool gate H2b, evaluation ruleset `ruleset-2026.10-m6` (rank/structure-based, honest INSUFFICIENT where calibration is pending), rule-based feasibility, salvage after a failed repair, tag signals in the planner, evidence rationale | **Accepted** | 2026-10-21 (M6) |
| ADR-026 | M7 graph and monitor decisions: graph projection in core, citation links on demand, SVG charts with table views, monitor full view as a dialog | **Accepted** | 2026-10-22 (M7) |
| ADR-027 | M8 counterfactual engine: pure dependency planner in core, branch materialized at creation, CACHE-labeled reuse, stored top-K result ids, deterministic comparison metrics with placeholder-only narratives, fixtures exempt from the live quota | **Accepted** | 2026-10-22 (M8) |
| ADR-028 | M9 blueprint composer: facts and constraints written by the app from stored evidence, R6 limited to interpretation and speculation, layered traceability validation, server-decided provenance on user revisions, append-only revisions with restore, hashed share tokens with scoped payloads | **Accepted** | 2026-10-22 (M9) |

---

## 2. Architecture decision records

### ADR-001: Modular monolith with two processes

- **Context:** A solo developer has about 10 days. The system needs long-running agent work and an interactive UI. Microservices would add deployment, observability, and contract overhead with no benefit at this scale.
- **Decision:** One pnpm workspace with shared packages. Two OS processes from one image: `web` (Next.js) and `worker` (orchestrator). They communicate only through PostgreSQL. *(Amended 2026-10-20 by ADR-017: both processes run in **one** deployment service under a supervisor, instead of two separately deployed apps.)*
- **Alternatives:**
  - A single Next.js process running agents in route handlers. Rejected: request timeouts, and secrets would sit in the web tier.
  - Microservices per role. Rejected: overhead.
- **Consequences:** Simple deployment and clear secret isolation. The worker is a single instance, which is fine for the event's quota-bound throughput.

### ADR-002: Always-on container hosting instead of serverless

- **Context:** The kit states *"Serverless functions are not a supported route"* for `qloo mcp`, and requires Node ≥ 22.19 with the harness installed. Agent runs can take minutes. Judges need consistent availability.
- **Decision:** ~~Deploy one Docker image as two always-on container apps (web, worker)~~ *(superseded by ADR-017)* Deploy one Docker image as **one always-on container service** on a container platform (default Fly.io; alternative Render). Disable scale-to-zero through judging.
- **Alternatives:**
  - Vercel for web + a separate worker host. Possible, but it splits platforms. Kept as a fallback for the web tier only, since the web tier never calls Qloo.
  - A single VM. Viable, but more operational work (TLS, restarts).
- **Consequences:** A small monthly cost and container ops (health checks, restarts). Full control of the child process.

### ADR-003: Qloo access through the official harness, not direct REST

- **Context:** The kit's API_ACCESS.md lists the supported surfaces as `qloo explore/exec/api/mcp` and allows *"an organizer-approved authenticated gateway"* as the only alternative. The requested stack mentions the "Qloo REST API". The REST endpoints are documented at docs.qloo.com, but the event credential is meant for harness use.
- **Decision:** `QlooPort` with `HarnessMcpTransport` (primary; persistent `qloo mcp` child) and `HarnessCliTransport` (`qloo exec` / `qloo api`; secondary). REST semantics are documented for understanding (API_CONTRACTS §5.3), but no direct HTTP client is built. A direct REST transport may be added **only** with explicit organizer approval.
- **Alternatives:** Direct `fetch` to `api.qloo.com` with `X-Api-Key`. Rejected as non-compliant with the kit's stated surfaces.
- **Consequences:**
  - Dependency on harness behavior and versions (pinned).
  - Tool schemas must be discovered live (V1).
  - Slight per-call overhead (stdio). Bounded by the persistent child process.

### ADR-004: Drizzle ORM instead of Prisma

- **Context:** The worker container also hosts the harness. We need precise SQL control for CHECK constraints, triggers, partial indexes, `FOR UPDATE` locking, `ON CONFLICT` upserts, and role-specific grants. We also need Zod alignment and fast iteration.
- **Decision:** Drizzle ORM (`drizzle-orm/pg-core`, `node-postgres` driver) with `drizzle-kit` SQL migrations.
- **Rationale:**
  - SQL-first schema in TypeScript; generated SQL migrations are readable and committed.
  - No separate query-engine binary, which keeps images small with no platform-binary mismatch.
  - First-class transactions and raw SQL escape hatches for locks and upserts.
  - `drizzle-zod` (or hand-written Zod) aligns JSON column validation.
  - Type inference without a codegen step, which suits AI-assisted iteration.
- **Alternatives:** Prisma: mature tooling and a great DX, but less ergonomic for raw locking patterns, triggers, and CHECK-heavy schemas, and adds a generated client step. A good choice in other contexts, but rejected here.
- **Consequences:** Some constraints (triggers, roles) live in hand-written SQL migrations. That is acceptable, since they are reviewed.

### ADR-005: PostgreSQL-backed job queue (pg-boss)

- **Context:** We need durable step jobs, retries, singleton keys, and cron, with minimal infrastructure.
- **Decision:** pg-boss on the same database.
- **Alternatives:**
  - BullMQ + Redis. Extra infrastructure.
  - Temporal or Inngest. Powerful, but too much to adopt in 10 days and an extra vendor.
  - A custom `SKIP LOCKED` table. Reinvents pg-boss.
- **Consequences:** Queue load sits in Postgres (small at our scale). Enqueueing is transactional with state commits, which is a major correctness benefit.

### ADR-006: Controlled state machine instead of a multi-agent framework

- **Context:** The requirement is six logical roles with evidence-driven behavior, budgets, reproducibility, and cancellation.
- **Decision:** One orchestrator with an explicit transition table. Roles are prompt contracts and handlers. There is no LangGraph, CrewAI, or similar framework.
- **Alternatives:** Agent frameworks provide loops and memory but obscure control flow, complicate budgets and reproducibility, and add dependency risk.
- **Consequences:** More upfront specification (done here). The behavior is fully testable (TEST_PLAN §4).

### ADR-007: The LLM proposes evidence queries; the orchestrator executes them

- **Context:** Letting a model call Qloo tools freely risks quota waste, unverifiable chains, and prompt-injection-driven calls. The kit permits giving MCP tools to an app's model, but does not require it.
- **Decision:** Roles output typed `EvidenceQueryProposal`s. The orchestrator validates them (state allowlist, entity grounding, budget) and executes them through `QlooPort`.
- **Alternatives:** Native tool-use loops with `qloo mcp` tools exposed to the model. Rejected for the core loop. This could be reconsidered for an optional "exploratory assistant" feature after the hackathon.
- **Consequences:** Deterministic, auditable, budget-safe. It also avoids forced `tool_choice`, which the default model family does not support.

### ADR-008: Deterministic evaluators own claim stances

- **Context:** The credibility of "supported by evidence" must not depend on model judgment.
- **Decision:** Versioned rule-based evaluators per test kind decide the stance. The LLM critic may add cited interpretation and may only *downgrade* confidence.
- **Consequences:** Some nuance is lost (rules are coarse), but honesty and reproducibility improve. Thresholds need live calibration (V1).

### ADR-009: Provider-agnostic LLM port; default Anthropic `claude-opus-5-5`

- **Context:** We need reliable structured outputs and strong reasoning for hypothesis generation and critique. Claude Code and Codex subscriptions do not provide runtime API access.
- **Decision:**
  - The `LlmPort` interface; the default `AnthropicProvider` with `claude-opus-5-5`, set via `LLM_MODEL`.
  - Structured outputs (`output_config.format`, SDK `messages.parse`).
  - Adaptive thinking with explicit `effort` per role (this model's default effort is `medium`).
  - The server-side refusal fallback.
  - Prompt caching on stable prefixes.
  - Not used: `temperature`, assistant prefill, and forced `tool_choice` (all unsupported on this model).
- **Alternatives:** OpenAI or another provider with JSON-schema outputs. Supported via the port. Choosing a different model or tier is the owner's decision, recorded in each experiment's configuration snapshot.
- **Consequences:**
  - A runtime API key and budget are required (R-05).
  - Text outputs are not sampling-reproducible, so reproducibility relies on recorded outputs (AGENT_WORKFLOW §14).
  - Exact SDK call shapes must be verified against the official SDK docs during M3.
  - Model IDs, the fallback model, the cost model, and credential requirements are specified in **ADR-018**.

### ADR-010: SSE with database polling for live activity

- **Context:** One-way, low-volume event streaming to the browser from a separate worker process.
- **Decision:** The web route streams SSE and polls `run_events` every 750 ms (indexed), with `Last-Event-ID` resume. `LISTEN/NOTIFY` is an optional optimization.
- **Alternatives:** WebSockets (bidirectional, not needed); a third-party realtime service (extra vendor).
- **Consequences:** Simple and robust across restarts. Slight DB load, which is negligible at our scale.

### ADR-011: Anonymous cookie workspaces; no accounts

- **Context:** Minimize personal data. Judges need instant access.
- **Decision:** A random 256-bit workspace secret in an httpOnly cookie; only its HMAC is stored. Read-only share links handle sharing.
- **Consequences:** A user who clears cookies loses access unless they exported the workspace key (S). This is acceptable for the hackathon and documented.

### ADR-012: UUIDv7 primary keys and deterministic experiment keys

- **Decision:** UUIDv7 for row identity (time-ordered, index-friendly). `experiment_key = sha256(JCS(ExperimentDefinition))` for configuration identity and deduplication. `request_hash` for Qloo cache identity.
- **Consequences:** Exact reproducibility semantics, and a unique constraint prevents duplicate experiments. All versions (prompts, ruleset, model, harness) are part of the key, so upgrading any of them yields new keys, which is correct.

### ADR-013: Counterfactuals default to holding hypotheses fixed

- **Context:** A "what-if" that regenerates everything conflates the variable's effect with LLM variance.
- **Decision:** The default mode re-tests the **same** hypotheses under the changed variables, recomputing only dirty queries. Regenerate mode is optional (stretch).
- **Consequences:** Clean, explainable comparisons with genuineness reporting.

### ADR-014: The fixture firewall

- **Decision:** Fixtures are synthetic and labeled. They are available only in dev/test. There is no code path from live transports to fixtures. Production refuses fixture mode, and the serializer blocks fixture-provenance data in production. Recorded live data is a separate category (REPLAY, still Qloo-sourced).
- **Consequences:** Development continues before the key arrives without any risk of misrepresenting data.

### ADR-015: REST route handlers for commands; RSC for reads

- **Decision:** All mutations and agent commands go through `/api/v1` route handlers with Zod contracts, which are testable and documented. Server Components read via repositories. Server Actions are not used for agent commands.
- **Consequences:** Slightly more boilerplate, but explicit contracts for E2E and future clients.

### ADR-016: Managed PostgreSQL (default Neon) and Fly.io (default host)

- **Status:** Confirmed engineering target in M0 on 2026-10-21: Fly.io for one always-on application service and Neon for managed PostgreSQL. No paid resources were provisioned; account access, region, spend authorization, and hosted validation remain M10.
- **Plan check:** [Fly.io pricing](https://docs.fly.io/about/pricing) lists a 2 GB shared-cpu-2x Machine at $13.39 per 30 days in `iad`/`ewr`, excluding other resource charges; prices vary by region. [Neon pricing](https://neon.com/pricing) lists Free at 100 CU-hours and 1 GB per project, and Launch at $0.106/CU-hour plus $0.35/GB-month. Use a paid, adequately budgeted database plan for the continuous worker rather than assuming the free quota covers judging. Recheck pricing and scale-to-zero settings before deployment. These are published rates, not measured Tessaloom costs.
- **Isolation validation:** M0 verifies root supervisor startup and distinct non-root child UIDs in Docker. Actual Fly.io account/platform configuration and the same isolation checks on the hosted Machine are still to be verified in M10; local results do not establish hosted behavior.
- **Rationale:** Managed backups and TLS; branchable databases for staging (Neon); always-on machines that run one service with a supervised multi-process container (Fly.io; ADR-017).
- **Alternatives:** Render (web + background worker + Postgres); Railway; Supabase Postgres.
- **Consequences:** Two vendors. A pre-tested fallback on Render is prepared on D9 (IMPLEMENTATION_PLAN §5).

### ADR-017: Single deployment service with two supervised processes

- **Date:** 2026-10-20 (architecture review). **Supersedes** the "two separately deployed apps" topology in ADR-001 and ADR-002.
- **Context:** The baseline deployed the same image as two platform apps (web and worker) so that the Qloo and LLM keys would never be in the web app's secret store. The review asked whether that complexity is justified for a solo, 10-day build. All eight product modules must be preserved, and nothing in the Qloo kit requires two services. The kit only requires a VM or container with Node ≥ 22.19, the harness installed, and `QLOO_API_KEY` as a secret, and rules out serverless.

**Options evaluated:**

- **A. Two deployment services** (baseline): one image, two platform apps (`web`, `worker`), separate secret stores.
- **B. One service, one OS process:** a Next.js server that also hosts the pg-boss worker and the `qloo mcp` child process.
- **C. One service, one container, two OS processes:** a tiny supervisor (PID 1 via `tini`) spawns `web` and `worker` as separate Node processes with **per-process environment allowlists** (and, as hardening, separate Unix UIDs).

| Dimension | A. Two services | B. One process | C. One service, two processes (**chosen**) |
|---|---|---|---|
| **Operational reliability** | Good. Independent restarts per app. Two health checks to keep green. | Weakest. A web crash or memory spike kills in-flight agent steps and the MCP child. Next.js internals (build output, request handling) share the event loop with long agent work. | Good. The supervisor restarts a crashed child with backoff. Repeated crashes exit the container so the platform restarts it. One health check covers both (`/api/health/ready` requires a fresh worker heartbeat). |
| **Security isolation** | Strongest. Secrets are isolated at the platform level; a web-tier compromise cannot see the Qloo or LLM keys. | Weakest. Secrets live in the web process memory and env. | Medium. The web process is started **without** Qloo or LLM keys (env allowlist). With UID separation, a web-process compromise cannot read `/proc/<worker>/environ`. A container-level compromise (root escape) would still expose them. **Residual risk accepted** (keys are event-scoped and quota-capped; spend limits are set at the provider). |
| **Background job execution** | pg-boss in the worker app | pg-boss inside the web server process; competes with requests | pg-boss in the dedicated worker process (same as A) |
| **Qloo MCP process lifecycle** | Child of the worker app; isolated | Child of the web server. Restarted with every web restart and deploy. Harder to manage around Next.js internals. | Child of the worker process (same as A). Restarted by the worker with backoff. The supervisor restarts the worker if needed. |
| **PostgreSQL requirements** | Required: state, events, queue | Required | Required. **No change.** A single managed Postgres; Redis is still unnecessary. |
| **Deployment complexity** | Two apps, two secret sets, two deploys per release, coordinated migrations and versions, two health checks | Lowest | Low: one app, one secret set, one deploy, one release migration. The supervisor is ~100 lines with no dependencies. |
| **Runtime cost** | Two always-on instances | One instance | One always-on instance (about half the compute of A). Size it for Next.js + worker + harness: start at 2 GB RAM, measure in M10. Vendor prices are not verified in this phase. |
| **Failure recovery** | Per-app restart; runs resume from the last commit | Any crash takes everything down; runs resume from the last commit | Per-process restart inside the container; container restart as a last resort. Runs resume from the last committed step (unchanged durability via Postgres). |
| **Solo implementation time** | Highest: extra app configuration, secret duplication, cross-app deploy ordering and debugging (estimated +3–5 h) | Lowest initially, but it violates the module boundaries and makes the worker's lifecycle fragile | Low: the supervisor script + env allowlists (estimated 1–2 h, including tests) |

- **Decision: Option C.** One deployment service and one Docker image. `tini` is PID 1, followed by `node scripts/start.mjs` (the supervisor), which:
  1. spawns **web** (`node apps/web/server.js`) with the allowlist `NODE_ENV, APP_ENV, PORT, HOSTNAME, DATABASE_URL, SESSION_SECRET, SHARE_TOKEN_PEPPER, ADMIN_TOKEN, LOG_LEVEL`, plus a supervisor-generated `PATH`. It never forwards `QLOO_*` secrets or `*_API_KEY`.
  2. spawns **worker** (`node apps/worker/dist/main.js`) with the allowlist `NODE_ENV, APP_ENV, DATABASE_URL, QLOO_API_KEY, QLOO_HOME, QLOO_MODE, QLOO_RATE_LIMIT_PER_MIN, GLOBAL_DAILY_*, ANTHROPIC_API_KEY, LLM_PROVIDER, LLM_MODEL, LLM_FALLBACK_MODEL, LOG_LEVEL` (plus `LLM_MODE`, added in M3 per ADR-022), plus the non-secret endpoint settings `QLOO_BASE_URL`, `QLOO_TRUSTED_BASE_URL`, and `QLOO_RAW_RETENTION` (added in M2 per ADR-019/ADR-021), plus the same generated `PATH`. The worker spawns `qloo mcp` with its own env in M2. `PATH` is derived only from the running Node executable's directory and `/usr/local/bin`, `/usr/bin`, `/bin`, with duplicates removed; the parent's `PATH` is discarded. In the Docker image it is `/usr/local/bin:/usr/bin:/bin`, so both `qloo` and its `/usr/bin/env node` shebang resolve. No `NODE_OPTIONS`, `LD_PRELOAD`, or unrelated parent variables are forwarded.
  3. **Enforced in M0:** when the supervisor runs as root, every selected child requires a valid positive non-root UID via `TL_WEB_UID` / `TL_WORKER_UID`; GID defaults to that UID unless a valid positive `TL_*_GID` is configured. Invalid, missing, or zero identities fail before any child is spawned. With `TL_ROLE=all`, the UIDs must be distinct. The Docker image supplies web UID 10001 and worker UID 10002. `QLOO_HOME` is owned by `tl-worker` with mode `0700`. The supervisor itself serves no traffic. An already non-root local supervisor keeps its current identity without requiring UID configuration; same-user process isolation remains weaker and is recorded. Hosted verification remains M10.
  4. Restarts a crashed child with exponential backoff (1 s → 30 s). After more than 5 crashes in 5 minutes it exits with code 1, so the platform restarts the container.
  5. Forwards SIGTERM/SIGINT to both children and exits after they stop (25 s grace period).
  6. Writes a startup log line listing the env variable **names** (never values) given to each child, for auditability.
- **Migrations:** run as the platform's release or pre-deploy command with the migrator credential, which is not part of either child's allowlist.
- **Scaling path:** the same image supports `TL_ROLE=all|web|worker`. If judging traffic ever requires horizontal web scaling, the web role can be deployed as a separate service without code changes, returning to option A. The worker must stay a **single instance** (one Qloo credential, an in-process rate limiter).
- **Consequences:**
  - Simpler, cheaper, faster to ship.
  - Security isolation drops from the platform level to the process level. This is mitigated by env allowlists, UID separation, the web env deny-list check at boot (kept), provider spend limits, and the Qloo quota guard.
  - The web tier cannot scale horizontally without splitting. That is acceptable for hackathon traffic.
  - The architecture, security, and test docs were updated accordingly (supervisor tests in TEST_PLAN §9).

### ADR-018: LLM model verification, fallback model, cost model, and credentials

- **Date:** 2026-10-20 (architecture review).
- **Verification of model identifiers** (official provider documentation, fetched 2026-10-20):
  - The Anthropic **Models overview** (`platform.claude.com/docs/en/about-claude/models/overview`) lists **`claude-opus-5-5`** (Claude Opus 5.5) as a current Claude API ID. It is a pinned dateless snapshot with a 1M context window, 128K max output, adaptive thinking (always on), **default effort `medium`**, and retirement "not sooner than September 22, 2027".
  - It lists **`claude-sonnet-5-5`** (Claude Sonnet 5.5) as current: 1M context, 128K max output, default effort `high`, retirement not sooner than September 28, 2027.
  - **Not yet verified with a live call:** whether the owner's API account and workspace can access these models. That requires the owner's key and is an M3 acceptance step: `GET /v1/models/claude-opus-5-5` and one minimal structured call, logged in TEST_PLAN §15.
- **Decision:**
  - **Primary model:** `LLM_MODEL=claude-opus-5-5` (unchanged).
  - **Configurable fallback model:** `LLM_FALLBACK_MODEL=claude-sonnet-5-5`. The gateway switches to the fallback for a **whole step** (never mid-conversation, because thinking blocks are bound to the model that produced them) when:
    - (a) the primary returns overloaded or 5xx errors after the SDK's retries;
    - (b) the run's remaining cost budget cannot cover the primary's estimated cost but can cover the fallback's;
    - (c) the owner sets `LLM_MODE=economy`.
  - Every `llm_invocations` row records the model actually used and `fallback_used`. The experiment's `configSnapshot` records both models, so experiment keys stay honest.
  - **Separate mechanism:** the provider's server-side **refusal** fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) stays enabled for safety-classifier refusals. It is independent of the availability and cost fallback above.
- **Pricing used for estimates** (official pricing page, fetched 2026-10-20; USD per million tokens):

  | Model | Base input | 5-min cache write | Cache hit | Output |
  |---|---|---|---|---|
  | Claude Opus 5.5 | $4.00 | $5.00 | $0.20 | $20.00 |
  | Claude Sonnet 5.5 | $2.00 | $2.50 | $0.10 | $10.00 |

  The 1M context is billed at standard rates (no long-context surcharge on these models). Adaptive-thinking tokens are billed as output tokens and are **included** in the output estimates below.

- **Estimated usage per run** (pre-measurement estimates. Replace them with measured values from `llm_invocations` after M6 and record the update here):

  | Run kind | Typical calls | Typical tokens (in / out) | Opus 5.5 typical | Opus 5.5 ceiling | Sonnet 5.5 typical |
  |---|---|---|---|---|---|
  | EXPLORATION (2 iterations) | 8 | 80K / 38.5K | **≈ $1.09** | ≈ $1.65 (3 iterations, 120K / 58K) | ≈ $0.55 |
  | COUNTERFACTUAL | 1–2 | 20–35K / 6–12K | ≈ $0.20 | ≈ $0.38 | ≈ $0.10 |
  | COMPOSITION | 1–2 | 25–50K / 10–20K | ≈ $0.30 | ≈ $0.60 | ≈ $0.15 |
  | REVALIDATION | 0–1 | ≤ 15K / 4K | ≤ $0.14 | ≤ $0.14 | ≤ $0.07 |

  Run budgets are adjusted to these estimates in AGENT_WORKFLOW §7: EXPLORATION `maxEstimatedCostUsd` **2.00**, COMPOSITION **0.70**.

- **Estimated totals for the event:**
  - **Development with real model calls** (CI uses the scripted provider at $0): about 30 explorations + 30 branches + 15 compositions ≈ **$45** on Opus 5.5.
  - **Judging period** (assumed 40 explorations + 80 branches + 30 compositions by judges and visitors) ≈ **$70** on Opus 5.5 (≈ $35 on Sonnet 5.5). Replay sample projects cost $0.
  - **Recommended prepaid budget: $150**, with a provider-console spend limit at that level and `GLOBAL_DAILY_LLM_USD=15` (raise to 25 during judging if traffic warrants). These are estimates, not measurements.
- **Credential requirements:**
  - A **Claude API key** from the Claude Console (`platform.claude.com`), in an organization with billing or prepaid credits enabled. **Claude Code, Claude Pro/Max, and OpenAI Codex subscriptions do not provide runtime API access for a deployed application**, so this key must be obtained and funded separately by the owner.
  - Stored only in the deployment's secret store and passed **only to the worker process** (ADR-017 allowlist). Never in the repository, the browser, CI (except the optional protected live-smoke environment), or recordings.
  - A dedicated Console **workspace** for Tessaloom with a **spend limit**, so the key can be revoked without affecting other work.
  - API rate limits depend on the organization's usage tier; check them in the Console before judging (not verified here).
- **Consequences:** Cost and availability risks are bounded and configurable. Model choice remains an owner decision, recorded per experiment.

### ADR-019: V1-observed Qloo contract

- **Date:** 2026-10-21 (V1 live validation; evidence in [research/QLOO_V1_VALIDATION.md](research/QLOO_V1_VALIDATION.md); 20 harness calls to `https://hackathon.api.qloo.com`).
- **Context:** Before V1, tool schemas, item fields, and several capability semantics were assumptions (U-1, U-5, U-6, U-7). V1 observed them through the official harness only.
- **Decisions:**
  1. **Endpoint configuration.** Every process that runs `qloo` sets `QLOO_BASE_URL=https://hackathon.api.qloo.com` and `QLOO_TRUSTED_BASE_URL=https://hackathon.api.qloo.com`. **M2 prerequisite:** add both (non-secret) variables to the worker allowlist in `scripts/start.mjs` and to `workerEnvSchema`, update ADR-017 and SECURITY.md §3.2, extend the allowlist unit tests, and add a container-smoke assertion that `qloo doctor --json` reports the hackathon endpoint as trusted under the supervised worker environment. The web allowlist is unchanged.
  2. **Transports.** Workflows use `qloo mcp` (primary) or `qloo exec` (fallback). They are proven equivalent (LC-12). `searchEntities` always uses `qloo api search`, because no search workflow exists. Endpoint checks never rely on `qloo api --dry-run`, whose printed URL ignores `QLOO_BASE_URL`.
  3. **Envelope parsing.** Parse both the result envelope and the bare failure object `{ error, operation, correlation_id }`, and map exit codes 1 (`QLOO_CONTRACT`) and 4 (`QLOO_AUTH`). Copy the harness's `provenance.requests`, `interpretation`, `query_intent`, `resolution`, and `execution.correlation_id` into the evidence trace.
  4. **Disambiguation.** `match: "exact"` is not sufficient for auto-acceptance: in LC-3 it selected a 0.21-popularity edition while the canonical entity (≈ 0.999) was an alternative. Gate H2 shows the selected entity plus its alternatives. Locality candidates are enriched with `searchEntities` `disambiguation` strings. Legacy `urn:entity:author` IDs are accepted as signals (LC-16) and labeled as legacy.
  5. **Evaluator redefinitions** (ruleset version bump, AGENT_WORKFLOW §8.2):
     - `AUDIENCE_BRIDGE` uses overlap lists and shared tag subtypes; there is no similarity score.
     - `LOCATION_FIT` becomes intra-locality concentration over geohash cells.
     - `MOMENTUM` is restricted to type and window combinations that return points; `book` → UNTESTABLE.
     - `TAG_RESONANCE` uses an observed tag-type allowlist that excludes `endorsement`.
     - `CROSS_DOMAIN_AFFINITY` reads `subtype` and uses relative affinity, preferring ≥ 2 signals.
  6. **Honesty about face validity.** Single-seed cross-domain results can be culturally surprising (LC-5a, LC-5b). The UI labels them as aggregate audience affinity. Claim tests (`CROSS_DOMAIN_AFFINITY`) prefer combined entity and tag signals. The per-seed discovery threads of the Collision Engine (AGENT_WORKFLOW §16) stay single-seed by design and are labeled as such.
- **Alternatives rejected:**
  - Calling REST directly to obtain names for geohash cells: rejected, not a supported event surface.
  - Trusting `describe` exact matches: rejected because of LC-3.
- **Consequences:**
  - M2 has a small, well-defined prerequisite in reviewed M0 code (decision 1), which needs a targeted re-review.
  - Evaluator rules change before M6.
  - Raw recordings for contract fixtures cannot be committed until R-08 is resolved, so contract tests in CI rely on hand-written fixtures that mirror the observed shapes (labeled synthetic), plus the manually run live suite.

### ADR-020: M1 data-layer decisions

- **Date:** 2026-10-21 (M1).
- **Decisions:**
  1. **Raw Qloo payload retention is off by default.** Until Qloo or the organizers confirm storage and redistribution rights (R-08), the database stores only structural summaries and the normalized facts needed for traceability. Pointers are verified at ingest (`verifiedAtIngest`). Turning retention on is a deliberate configuration change, and the schema enforces consistency (`raw_retained` ⇔ `raw` present).
  2. **Immutability by triggers.** Append-only tables reject `UPDATE` through triggers, which apply to every role and are testable, while role grants (`sql/roles.sql`) stay as defense in depth.
  3. **Pure-TS SHA-256 and RFC 8785 JCS in `@tessaloom/core`.** This keeps `core` free of Node imports (lint-enforced) and makes deterministic keys synchronous. It is verified against FIPS 180-4 vectors and against system `shasum` for the golden experiment key.
  4. **`drizzle-kit` transitive `esbuild` override.** `drizzle-kit@0.31.11` pulls `esbuild@0.18.20` through `@esbuild-kit/core-utils` (GHSA-67mh-4wv8-2f99, dev-server only). A pnpm override pins that path to the patched `esbuild@0.25.12` instead of adding an OSV exception. `drizzle-kit generate` and `check` were verified to work afterwards.
  5. **Exhaustive role configuration.** `RunConfig.effortByRole` must name all six roles (Zod 4 enum-keyed records are exhaustive), so every run snapshot is complete.
- **Consequences:**
  - Contract tests cannot rely on stored raw recordings while retention is off.
  - Without raw snapshots, replay of sample projects depends on R-08: either permission arrives, or samples run live within the quota guard (IMPLEMENTATION_PLAN §5).

### ADR-021: M2 live Qloo adapter decisions

- **Date:** 2026-10-21 (M2).
- **Decisions:**
  1. **Endpoint settings reach only the worker.** The supervisor forwards `QLOO_BASE_URL`, `QLOO_TRUSTED_BASE_URL`, and `QLOO_RAW_RETENTION` to the worker only. `workerEnvSchema` requires HTTPS and rejects a base URL that differs from the trusted URL, because the harness would refuse it. The image defaults both URLs to `https://hackathon.api.qloo.com`. Worker readiness (`qloo --version` and `qloo doctor --json`, with no network) is `ready` only when the credential is configured **and** the doctor reports exactly that endpoint as trusted.
  2. **`@modelcontextprotocol/sdk@1.32.1` instead of the kit's `1.30.1`.** OSV reports five advisories against 1.30.1 (GHSA-22jm-h49p-29qw, GHSA-46jr-4wx8-v453, GHSA-6prh-2h8m-c8cw, GHSA-6qxp-vccf-f47h, GHSA-rvq5-wwqv-78pq; three high), all fixed by 1.32.0. 1.32.1 (published 2026-10-05) keeps the same stdio client API and was verified live against `qloo mcp`.
  3. **Routing.** Workflows go to MCP first, then fall back to the CLI on `MCP_UNAVAILABLE`/`HARNESS_NOT_FOUND`; both are live harness surfaces. Search always uses `qloo api search`. There is **no code path to fixtures** from the live router, adapter core, or recorder; an ESLint rule enforces this. `FixtureTransport` refuses production and any file without the synthetic label.
  4. **Local `UNSUPPORTED` answers.** Combinations V1 observed as rejected upstream (trends + `book`) return `UNSUPPORTED` without spending quota. Evaluators map this to `UNTESTABLE`.
  5. **Quota and throughput.** One atomic reservation (`consumeWithinLimit`) is made before every live call, retries included. The token bucket defaults to 20/min, concurrency to 2, the timeout to 30 s, and there are at most 2 retries, only for `retryable` errors.
  6. **Cache in memory only.** Raw retention is off (ADR-020), so the adapter caches outcomes in process memory (TTL: 7 days for identity lookups, 1 day otherwise). Each cache hit still writes its own `tool_invocations` row (`CACHE`, linked to the source invocation).
  7. **No derived scores.** `compareAudiences` returns Qloo's tag profiles and overlap lists only; the adapter computes no similarity metric. All affinity values remain aggregate audience signals.
  8. **Migrator entry split.** The release-step migrator has its own entry (`migrate-cli.ts`). Bundling the database library into the worker previously triggered the migrator's "run when executed directly" guard, because `import.meta.url` equals the worker bundle; this was found and fixed in M2.
- **Consequences:**
  - `qloo api search` returns the raw API response without harness provenance, so search invocations record only Tessaloom's own request arguments.
  - Locality candidates from `describe` arrive without disambiguation (confirmed live in M2); M5 enriches them via `searchEntities`.

---

### ADR-022: M3 LLM gateway decisions

- **Date:** 2026-10-21 (M3).
- **Context:** IMPLEMENTATION_PLAN M3 said the §13.2 validators live in `packages/agent` and are "called by the gateway". The architecture boundaries (ESLint) allow `llm-gateway → core` and `agent → core` only, so the gateway importing `agent` would create a forbidden edge (and `agent` must stay pure).
- **Decisions:**
  1. **Validators are injected.** `packages/llm-gateway` depends on `core` only. Each `generate()` call takes an optional `validate(value) → ValidationIssue[]` callback. The orchestrator (worker composition) builds it from `packages/agent` validators with the experiment's known IDs. The gateway owns schema parsing, the single repair attempt, and the issue-to-repair-message conversion. Persistence is also injected (`LlmInvocationRecorder`); the worker maps it to the `recordLlmInvocation` repository. No package gains a new dependency edge.
  2. **SDK call shape (verified against `@anthropic-ai/sdk@0.131.0` types).** `client.beta.messages.create(...)` with `system: [{ type: "text", text, cache_control: { type: "ephemeral" } }]`, `thinking: { type: "adaptive" }` (no display, nothing stored), `output_config: { effort, format: { type: "json_schema", schema } }`, and, when enabled, `betas: ["server-side-fallback-2026-07-01"]` with `fallbacks: "default"`. Calls with `max_tokens > 16000` use `beta.messages.stream(...).finalMessage()`. No `temperature`, no prefill, no forced `tool_choice`. The schema comes from the SDK's `zodOutputFormat(schema).schema` helper. We parse and validate ourselves instead of using `messages.parse`, because the repair loop needs the raw text and Zod issues, and server-side fallbacks require the beta endpoint.
  3. **Typed claim parameters.** The strict structured-output transform sets `additionalProperties: false` on every object, so a `z.record` would only allow `{}`. `HypothesisDraft.claims[].params` and `EvidencePlan.queries[].args` are now a strict `ClaimParams` object (`signalEntityIds`, `targetDomain`, `targetEntityId`, `tagEntityIds`, `optionEntityIds`, `compareEntityIds`). All references are internal `cultural_entities` UUIDs. `HypothesisRevision` was added for R3 revisions.
  4. **Prompts in code, not `.md` files.** Templates live in `prompts.ts` so they bundle into the worker without file-system access. Each template has a semantic version and a SHA-256 content hash over `{ system, task }`. `promptVersions` records `version+hash12`. Untrusted input is JSON inside `<untrusted_input>`, with `<`, `>`, and `&` escaped so the data cannot close the delimiter.
  5. **Policies.**
     - Repair: at most 1; the conversation is append-only; each attempt is its own `llm_invocations` row linked by `repair_of_id`.
     - Refusal: no retry, outcome `REFUSED`. The server-side fallback is the only re-attempt.
     - Truncation: 1 retry at 1.5× `max_tokens`, bounded by a ceiling (default 32 000) and the budget.
     - Unavailability (429/5xx/529/network after SDK retries): the whole step restarts on `LLM_FALLBACK_MODEL` with a fresh conversation. Auth or bad-request errors return `CONFIGURATION` and are never retried.
  6. **Budget enforcement and model choice.**
     - Before every call (repairs and retries included), the gateway checks the remaining USD, call, and output-token budgets that the caller passes. It uses a worst-case estimate: uncached prompt at about 3.5 characters per token, plus the full output cap.
     - It uses the primary model unless economy mode is on or only the fallback fits the remaining budget. If neither fits, it makes no call and returns `BUDGET`.
     - Models without a price entry are rejected unless explicitly allowed (scripted provider).
     - A response served by a different model (server-side fallback) is recorded as `fallback_used` and priced at the serving model.
- **Consequences:**
  - The regex-based `SafeUseValidator` targets audience inference, eligibility, individual probability, and causation phrasing. It allows user-chosen themes (for example a queer-cinema night). It is a guardrail, not a classifier; M10 reviews false negatives on demo traffic.
  - The `EntityGroundingValidator` checks every UUID. It cannot detect ungrounded *free-text* entity names in prose; prompts require IDs, and creative flavor goes in `creativeElements`.
  - `LLM_MODE` (`standard` | `economy`) is a worker-only variable. `LLM_PROVIDER=scripted` is rejected when `APP_ENV=production`, like fixtures. The `ANTHROPIC_API_KEY` remains on the worker allowlist only.
  - Owner-run live checks LM-1…LM-3 remain pending, because no paid calls were authorized.

---

### ADR-023: M4 orchestrator decisions

- **Date:** 2026-10-21 (M4).
- **Decisions:**
  1. **The state machine lives in `packages/core`.** The worker applies transitions at step commits, and the web process applies them at human gates, cancellation, and retry. The web may import only `core` and `db`, so the transition table moved from `packages/agent/src/machine.ts` (AGENT_WORKFLOW §5.2) to `packages/core/src/machine.ts`; `packages/agent` re-exports it.
  2. **Pure handlers, one commit per step.**
     - `executeStep` (`packages/agent/src/steps.ts`) reads a read-only `StepContext` and calls Qloo and the LLM only through structural ports, which `QlooAdapter` and `LlmGateway` satisfy without casts.
     - It returns a `CommitPlan` and never writes. The worker loads the context, runs the handler, re-checks `state_version` under a row lock, and persists in **one** transaction: the plan, the run events, the transition, usage, the experiment status, and the next `run.step` job (a transactional pg-boss `send` through the same client, `withPgTx`).
     - Tool and LLM invocation rows are written when each call happens, as an audit trail (§6.2), so a crashed attempt keeps its invocations and quota usage.
  3. **pg-boss 12.37.0 topology.**
     - The release migrator installs the `pgboss` schema and the queues, because the app role has no DDL rights (`roles.sql` grants DML on `pgboss`).
     - `run.step` uses policy `exclusive` with singleton key `run:<id>:<version>`, `retryLimit 2`, `retryDelay 15 s`, and `expireInSeconds 600`.
     - Maintenance queues: `maintenance.expire-paused-runs` (every 15 min) and `maintenance.recover-runs` (every 5 min; re-enqueues runnable runs idle for more than 15 min).
     - The worker supervises and schedules. The web process only sends.
  4. **Deterministic grading happens at collection time.** Raw responses are not retained (R-08), so evaluators grade each claim in `COLLECTING_EVIDENCE` from the in-memory response and record facts with `verifiedAtIngest`. `EVALUATING_EVIDENCE` then computes statuses and scores, runs the R4 critique, and checks termination. The critique is stored in `hypotheses.score_breakdown.critique`, because evidence rows are append-only.
  5. **Deterministic evidence planning.** Typed `ClaimParams` (ADR-022) fully determine each query. The planner maps claims to allowlisted methods, deduplicates identical queries, and trims by hypothesis priority to the remaining Qloo budget (`UNTESTED_BUDGET`). R4 uses the LLM for critique only, which saves one LLM call per iteration.
  6. **The worker publishes its run configuration.**
     - Each heartbeat carries the worker's `RunConfig`: models, efforts, prompt `version+hash`, adapter, harness, and ruleset (`worker_heartbeats.run_config`, migration 0002).
     - The web stamps new runs with it and takes the experiment mode (`fixture` or `live`) from the worker. Without a fresh heartbeat, a start returns `503 WORKER_OFFLINE`.
     - `/api/health/ready` requires a heartbeat younger than 30 s, judged by the database clock.
     - The worker beats only once its job consumer is running.
  7. **Root EXPLORATION definitions have no seeds.** Seeds are resolved from the brief during the run and recorded in `experiment_seeds` at `DISCOVERING`. The brief content hash already pins them in the experiment key.
  8. **The wall-clock budget counts only runnable time**, summed from `STATE_ENTERED` events. Time spent paused at a gate is not charged.
  9. **Retry after a transient failure.**
     - A failure is transient when it is `LLM_UNAVAILABLE` or `STEP_RETRIES_EXHAUSTED`. Such failures store `error.transient` and `error.failedState`.
     - A guarded `RETRY` event, the only transition out of a terminal state, re-enters `failedState` from `FAILED` (UI_UX_SPEC §6, "Retry step").
     - Permanent failures return `409`.
  10. **Budget termination (§12 rule 4).** The run emits `BUDGET_EXHAUSTED` and ends `COMPLETED_WITH_LIMITS` when no planned query fits the remaining Qloo budget, or when another revision round cannot be afforded.
  11. **SSE by database polling.** The stream polls every 1 s and resumes from `Last-Event-ID` or `?after=`. It sends a `: ping` every 15 s and ends with `event: run-terminal` on a paused or terminal state. Each connection lasts at most 10 min, after which the client reconnects. LISTEN/NOTIFY is a later optimization.
  12. **Web API security.**
      - The `tl_ws` cookie holds a random secret; only its HMAC is stored.
      - CSRF protection uses a double-submit `tl_csrf` token plus an `Origin`/`Host` match on every mutation.
      - Rate limits run in process (single service): 6/min per workspace and 20/min per IP hash for starts; 60/min for other mutations.
      - Bodies are limited to 64 KB.
      - Error envelopes carry a `requestId` and no internals.
- **Consequences and M4 limits (deliberate, for M5/M6):**
  - R2 uses no LLM: an exact single candidate is auto-accepted, and anything else goes to H2.
  - Tags are not fetched yet, so collision novelty is `REDUCED_INPUTS`.
  - Feasibility is a flat 0.6 baseline.
  - The V1 evaluator thresholds are placeholders until the M6 calibration.
  - COUNTERFACTUAL, COMPOSITION, and REVALIDATION states fail with `STATE_NOT_IMPLEMENTED` (M7/M8).
  - After a failed repair, an ungrounded element is not yet dropped; the run fails with `LLM_INVALID_OUTPUT`.
  - The worker's `ScriptedLlmProvider` has no scripted outputs, so a scripted deployment fails closed with `LLM_NOT_CONFIGURED`. Deterministic scripted runs exist in the test harness only.

---

### ADR-024: M5 brief, resolution, and discovery decisions

- **Date:** 2026-10-21 (M5).
- **Decisions:**
  1. **Resolution follows the V1-observed contract (ADR-019).**
     - Typed interests use `describe(entity, type)`. `qloo api search` (the only plain search) is called only when `describe` finds nothing or asks for input.
     - Untyped interests use `describe(entity)` plus `find_tags`, because an interest may be a tag and one concept maps to several tags (V1 findings 2 and 5).
     - The venue locality uses `describe(…, locality)`, then `api search --type locality`, which supplies the disambiguation strings `describe` omits (V1 finding 3).
     - All candidates are merged without duplicates. **Exact-single** auto-accepts only one candidate whose name equals the user's text, ignoring case and accents. A harness `exact` pick alone is never trusted (V1 finding 1; CI-A1).
  2. **H1 edits are user input.** Changing an interest's world at gate H1 creates a `PENDING` resolution record with the user's type hint, so the edit is stored as `USER_PROVIDED` and the model's `IntentFrame` stays unchanged. Editing the brief creates a new version and a new experiment.
  3. **H2 covers tags and the locality.** A tag can be chosen as a seed; tag seeds thread through `recommend(signal_tags=…)`. The locality row uses index `interests.length` and becomes the experiment's `location` seed, which `LOCATION_FIT` uses.
  4. **Tag enrichment is budgeted.**
     - Seeds get one `entity_tags` call each.
     - Thread items get per-entity `entity_tags` calls, because a multi-entity call merges tags without attribution (V1). At most 8 such calls are made, prioritized by bridge items, then by rank.
     - Discovery never spends into the half of the Qloo budget reserved for evidence.
     - Candidates whose elements lack tags are flagged `REDUCED_INPUTS` (CC-5).
  5. **Grounding scope (§13.2).** R3 is grounded in every entity of the experiment (seeds, thread results, tags), not only the pool. R3 still weaves from the pool and receives the other entities as `discovered`, for example as shortlist options. Prompt `r3.generate` was bumped to 1.1.0.
  6. **Collision engine in core.** `buildCollisionCandidates` / `selectPool` are pure and shared by the worker and the browser, so the tension slider can re-select the pool from stored scores. All candidates are stored, capped at 40 per domain pair.
  7. **Development and E2E data are synthetic and labeled.**
     - `QLOO_MODE=synthetic` uses a deterministic `SyntheticFixtureTransport`: fictional names, `FX-` IDs, transport `FIXTURE`, so every record is `DEVELOPMENT_FIXTURE`. It mirrors the V1 quirks and is refused in production by the environment schema and the supervisor. It is never a fallback for live failures.
     - `LLM_PROVIDER=scripted` uses deterministic R1/R3/R4 stand-ins, which report the model id `scripted-demo` at $0 (never a real model name).
     - The UI shows the FIXTURE banner, and the experiment view lists the LLM providers used.
  8. **Fixture firewall through the cache.**
     - The adapter no longer caches fixture-transport results.
     - Migration `0003_fixture_coupling_through_cache` makes the coupling triggers resolve a CACHE invocation's effective origin through `cache_source_invocation_id`.
     - Before this fix, cached fixture data could be labeled `QLOO_SOURCED`. The bug was found by the WebKit E2E run.
  9. **The Qloo rate limiter applies to live traffic only.** Fixture transports bypass it.
- **Consequences:** Resolution can take two calls per interest (`describe` + `search`/`find_tags`), and locality resolution takes two. M6 calibration must account for this in the Qloo budget.

### ADR-025: M6 collision pool gate, evaluators, feasibility, and failed-repair handling

- **Date:** 2026-10-21 (M6).
- **Context:** M4 shipped placeholder evaluators (an affinity-median threshold), a constant feasibility of 0.5, and a failed repair that always failed the run. V1 showed that absolute affinities are not comparable across calls and can be flat (0.883–0.899 for one book → movies, finding 7), that some tag types are noise (finding 6), that `compare` has no similarity score, that `trends` is empty for several types, and that `where_popular` returns unnamed geohash cells. No live calibration run has been authorized yet.
- **Decisions:**
  1. **Gate H2b — pool confirmation.**
     - The plan says the tension slider previews the pool client-side and "commit continues the run".
     - A new paused state, `AWAITING_POOL_CONFIRMATION`, sits between `BUILDING_COLLISION_POOL` and `GENERATING_HYPOTHESES`, with the event `USER_CONFIRMED_POOL` (guard: pool ≥ 3). Migration `0004` adds the enum value.
     - The browser previews with core `selectPool` over the stored candidate scores. The server re-selects with the same function and candidate key (`elementEntityIds.join("|")`), so preview and commit cannot diverge.
     - The committed τ is recorded in the `CONFIRMATION_RECEIVED` event, not in the experiment key: a human gate answer is a decision on a run, not a new experiment.
  2. **Evaluation ruleset `ruleset-2026.10-m6`.** It replaces the placeholders. Every rule is either rank- or structure-based, or it returns INSUFFICIENT with the note "evaluator pending live calibration". No threshold was invented.
     - `CROSS_DOMAIN_AFFINITY`:
       - SUPPORTS: the target is in the top quartile of K = 20.
       - NEUTRAL: the target is present below the top quartile, or the affinities are effectively tied (spread < 0.005, the published precision).
       - CONTRADICTS: the target is absent from a full top K.
       - INSUFFICIENT: fewer than K results came back.
       - `FIELD_UNAVAILABLE`: no affinity values were returned.
       - A tag-filtered claim with ≥ m = 3 results SUPPORTS; a domain-only claim is NEUTRAL, because Qloo returns results for any signal.
     - `SHORTLIST_FIT`: top third → SUPPORTS, bottom third → CONTRADICTS, otherwise NEUTRAL. It needs n ≥ 3 options.
     - `AUDIENCE_BRIDGE`: shared tags or matching entities → SUPPORTS. Otherwise INSUFFICIENT (the subtype-overlap test is pending calibration). It never CONTRADICTS.
     - `TAG_RESONANCE`: the theme tag is present with an allowlisted content tag type → SUPPORTS; otherwise NEUTRAL.
     - `LOCATION_FIT`: INSUFFICIENT, descriptive only. The concentration threshold is pending calibration, and venue coordinates are unknown.
     - `MOMENTUM`: SUPPORTS when the rank velocity is positive in a majority of the latest 3 points; NEUTRAL otherwise; INSUFFICIENT for an empty series.
     - `AUDIENCE_PROFILE`: always NEUTRAL (descriptive).
     - Every fact is pointer-verified against the response at ingest. Each evidence record stores the rule in plain language in the new `evidence_records.rationale` column (APP_DERIVED), which the UI shows as "SUPPORTS because …".
  3. **Audience affinity is never creative fit.**
     - Evaluators only grade the claim's typed question.
     - The UI labels every number as an aggregate audience signal.
     - The concept text is `CREATIVE_SPECULATION`; the critic's notes are `MODEL_INTERPRETATION`.
  4. **Rule-based feasibility (`feasibility-1.0.0`).** It replaces the constant 0.5.
     - Base score 0.8 ("plausible, not proven"). Penalties:
       - CAPACITY −0.3: the format's minimum audience exceeds the venue capacity;
       - BUDGET −0.2: a low budget band with costly elements;
       - DURATION −0.2: a multi-day format in a slot under 4 hours;
       - VENUE −0.2: physical needs at an online venue.
     - Bonus: LOCATION_EVIDENCE +0.1.
     - The result is clamped to [0.1, 1]. Every applied rule is stored in `scoreBreakdown.feasibility` and shown in the score breakdown. Unknown constraints are never penalized.
  5. **Failed repair (TEST_PLAN §8 "LLM ungrounded entity").**
     - When the one repair attempt still fails semantic validation but the output is schema-valid, the gateway returns it as `salvage`.
     - R3 keeps only drafts that pass grounding and safe-use. Ungrounded elements and invalid claims are dropped, as are drafts with fewer than 2 elements or no claims. Every drop is logged as a `VALIDATION_FAILED` event.
     - The R4 critique keeps only entries that pass the critique validator, so the critic still cannot upgrade a stance (HL-A3).
     - If nothing survives, the step fails with `LLM_INVALID_OUTPUT`, as before ("LLM invalid twice").
  6. **Planner tag signals.**
     - Tag seeds are sent as `signal_tags`.
     - A non-recommend test whose only signals are tags is marked `UNSUPPORTED`, so the claim is `UNTESTABLE` and no request is made.
     - Claims the planner drops are never sent to Qloo.
  7. **Raw retention stays off.** The worker now passes `QLOO_RAW_RETENTION` (default `off`, R-08) to the recorder. The §7.1 pointer-verification test turns it on only inside its own test database.
- **Consequences:**
  - Without live calibration, many claims grade INSUFFICIENT or NEUTRAL, and hypotheses often settle as `PARTIALLY_SUPPORTED`. This is honest, but less conclusive in demos.
  - Live calibration (LC runs with owner authorization) must set the subtype-overlap ω, the location α/r, and the momentum φ, then bump the ruleset version. Stored evidence keeps the version that graded it.

### ADR-026: M7 evidence graph and activity monitor

- **Date:** 2026-10-22 (M7).
- **Decisions:**
  1. **One projection.** `core/graph.ts` turns the experiment read model into nodes and edges. The API serves it, the canvas and the List view render the same output (EG-A4), and unit tests pin it. Nodes exist only for stored records. Hypotheses are `CREATIVE_SPECULATION`, claims are `MODEL_INTERPRETATION`, and evidence and entities keep the provenance stored with them (`DEVELOPMENT_FIXTURE` for synthetic data). Data-backed nodes carry the tool invocation id for Trace (EG-A3).
  2. **Readable by default.** Evidence → entity "cites" links cross the whole canvas, so they are off by default and always shown for the selected node. The List view uses the same filters, so the two views stay equivalent. The layout is deterministic and layered (entities → hypotheses → claims → evidence). Dragged positions are saved per experiment in `graph_layouts`.
  3. **Encoding beyond color (EG-A1).** Node shape encodes the type. The existing provenance border styles plus a text label encode the origin. Edges use stroke patterns per provenance.
  4. **Keyboard.** Every node is focusable. The arrow keys follow connections (left and right) or move within a column (up and down), Enter or Space opens the inspector, and a polite live region announces each move.
  5. **Monitor.** The dock gains a full view (dialog) with:
     - a state-duration chart, where gates are shown as waiting time;
     - Qloo calls by workflow, with data origin;
     - AI steps with model, attempts, and cost;
     - the complete, filterable timeline.

     Charts are inline SVG with a "View as table" toggle (no Recharts dependency). The SSE client shows "Reconnecting…" and relies on EventSource's `Last-Event-ID` resume. AM-A2 is verified after a forced offline period in E2E.
  6. **No reasoning anywhere (AM-A3).** The provider keeps only text blocks. Unit tests check that no `llm_invocations` or `run_events` column names reasoning or thinking. An integration test walks every stored event payload for such keys.
- **Consequences:** EG-A2 is measured on local hardware only. CI runners may be slower; the test reports the numbers and does not fail on them.

### ADR-027: M8 What-if engine

- **Date:** 2026-10-22 (M8).
- **Decisions:**
  1. **One planner, two processes.** The evidence planner moved from `agent` to `core`, because the web process (preview and branch creation) and the worker must compute identical query keys. `core/counterfactual.ts` applies the delta and re-plans every held claim under the branch variables, holding the parent's plan date. It then classifies each claim as REUSE, INHERIT, DIRTY, or UNSUPPORTED (AGENT_WORKFLOW §15.2). Dirty queries are counted per unique query key; reused queries per unique parent key.
  2. **Materialize at creation.** One transaction:
     - creates the branch experiment (deterministic key: the same delta returns the same branch);
     - copies seeds with the delta applied;
     - copies the parent's threads and pool, re-selecting the pool at the branch tension;
     - copies the hypotheses (`inherited_from_id`, same lineage) and re-parameterizes the claims;
     - copies reused evidence through new CACHE invocations whose `cache_source_invocation_id` points at the original call.

     The critic's notes are not carried over, because they described the parent's evidence set. The COUNTERFACTUAL run then only collects (dirty claims plus threads into added domains), re-grades deterministically, rescores, and compares.
  3. **Stored result identifiers.** `evidence_records.result_ids` (migration 0005) keeps the ordered top-K Qloo ids of each graded result: identifiers only, at most 50, never the payload. That is the same kind of derived data the THREAD relations already store. It makes overlap@K, RBO, and entered/exited computable without raw retention (R-08).
  4. **Deterministic metrics, honest narratives.**
     - `core/compare.ts` computes per-query, per-claim, and per-hypothesis deltas, plus the drift index.
     - The R5 narrative may contain numbers only as `{{metric:ID}}` placeholders and may cite only evidence in the comparison.
     - A rescore-only branch must not imply new data (validator `IMPLIES_NEW_DATA`).
     - If R5 fails, the deterministic template (APP_DERIVED) is used. The page labels which one it shows.
  5. **Unsupported deltas are refused, not approximated:** new seeds (need ad hoc resolution), tag constraints and audience bands (harness parameters PENDING), and regenerate mode.
  6. **Fixtures never draw on the live quota.** The adapter reserves the global daily Qloo quota only for non-fixture transports. M4–M7 charged synthetic calls too, which made a long synthetic E2E session hit `QUOTA_GUARD_ACTIVE`. The M4 crash-recovery test asserted that old behavior and now asserts 0 for fixture traffic. Per-attempt reservation for live transports stays pinned by the adapter unit tests.
  7. **Experiment focus.** The project's main views use its latest root experiment. The What-if Lab sets a focus experiment, so the activity dock streams the selected branch's run and its gate H4.
- **Consequences:**
  - Branching is fast and exact, but hold-fixed hypotheses keep their parent's wording; a swapped seed changes the evidence, not the text.
  - Live-provider behavior (cache hits and retries reducing or adding transport calls relative to `plannedDirtyQueries`) is unverified.
  - Ad hoc resolution and REVALIDATION remain open.

---

### ADR-028: M9 Experience Blueprint Composer and sharing

- **Date:** 2026-10-22 (M9).
- **Decisions:**
  1. **The app writes the facts; the model writes the ideas.**
     - `core/blueprint.ts` turns the selected hypotheses' latest graded evidence into blocks deterministically: `APP_DERIVED`, or `DEVELOPMENT_FIXTURE` for synthetic evidence. Each block cites exactly its evidence record. The stance picks the section: SUPPORTS → audience, CONTRADICTS → risks, other stances → measurement.
     - Constraints come from the brief (capacity, budget band, duration, venue), from the feasibility rules, and from contradicting evidence (`deriveConstraints`).
     - R6 (`r6.compose`, `BlueprintDraft` schema) may only add `MODEL_INTERPRETATION` or `CREATIVE_SPECULATION` blocks, mitigations for known constraint keys (shown as AI interpretation), open questions, and a title/concept. It cannot emit a fact, a Qloo value, or a user block. The separation of supported facts, AI interpretations, and unverified assumptions is therefore structural, not a prompt instruction.
  2. **Layered traceability validation.**
     - At composition, `blueprintDraftValidator` checks that:
       - citations are a subset of the selected hypotheses' evidence;
       - numbers are a subset of the numbers in the brief, facts, and hypotheses;
       - no outcome claims are made (`OUTCOME_CLAIM`: attendance, sales, revenue or success promises);
       - mitigations reference only known constraint keys.
     - Failed blocks are salvaged individually after one repair.
     - The VALIDATING_BLUEPRINT step re-runs `traceabilityIssues` against all of the experiment's evidence: one repair, then offending blocks are dropped and logged.
     - Only a fully traceable revision is committed. The draft lives in `experience_blueprints.draft_content` / `draft_meta` (migration 0006) between the two steps.
  3. **Provenance on user revisions is decided by the server.** `normalizeUserRevision` treats each kind of change as follows:
     - Unchanged blocks keep their provenance.
     - An edited block that keeps its citations keeps its provenance with `edited: true` (shown "Edited by you").
     - A new block, or an edited block whose citations changed, becomes `USER_PROVIDED`; citations must still resolve.
     - Constraints are immutable from the client.
     - An edited concept becomes `USER_PROVIDED`.
  4. **Append-only revisions.** Every edit, section recompose, and restore creates revision n+1. Restore copies the stored old revision verbatim on the server and ignores the client's copy, so a restore cannot carry forged provenance. Past revisions are viewable read-only. Accepting a blueprint changes its status, never its content.
  5. **Composition sources and gating.**
     - A blueprint is composed from 1–3 hypotheses of a COMPLETED or COMPLETED_WITH_LIMITS EXPLORATION run, or of a COUNTERFACTUAL run (What-if branch).
     - Composition is refused while any run on that experiment is non-terminal; at gate H3 the dialog records the selection first.
     - Branch blueprints cite the branch's CACHE-reused evidence, which resolves like any other evidence.
     - The project context exposes `explorationRun` separately from the latest run, so a COMPOSITION run never changes the Hypothesis Lab's gates. The blueprint page focuses its own experiment so the dock streams the composition and the page updates live.
  6. **Share links (SECURITY §4.3).**
     - The token is 32 random bytes, base64url, shown once; the database stores `sha256(token ‖ pepper)` only.
     - Payloads are built per scope (blueprint, experiment, project) and contain no workspace, project, experiment, run, or invocation ids.
     - Responses carry `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`, through both the API and `next.config` `headers()` for `/share/*`.
     - Lookups are limited to 30/min per IP hash.
     - An unknown, revoked, or expired token gets the same 404 "This link is no longer active.".
     - The share page fetches with `credentials: "omit"`, so a viewer's own workspace cookie is never used.
  7. **Exports.** The Markdown export (`blueprintMarkdown`) contains:
     - a fixture banner when any evidence is synthetic, and the provenance legend;
     - every section, with each block's provenance label and `[E-n]` citations, plus the constraints table;
     - open questions, and an evidence appendix with stance, rule, origin, and retrieval date;
     - the disclaimer that Qloo values are aggregate affinity, not attendance, sales, or commercial success.

     The JSON export carries the same content plus the traceability report. Print uses a print stylesheet; there is no server-side PDF.
- **Not implemented (moved to M10 or later):** optional gap-fill queries during composition (≤ 4 Qloo calls). Blueprints use only already-collected evidence. Global CSP/HSTS headers are M10 hardening.
- **Consequences:**
  - The evidence share of a blueprint is bounded by what the hypotheses already tested. Thin evidence yields a speculation-heavy meter, and that is reported honestly.
  - Fact blocks restate the deterministic evaluator's rationale, so their wording is formulaic by design.
  - The live R6 output quality (Anthropic) is unverified. All M9 tests use the scripted provider.

---

## 3. Key trade-offs

| Trade-off | Chosen side | Cost accepted |
|---|---|---|
| Honesty vs. impressive demos | Honesty: INSUFFICIENT/UNTESTABLE shown openly | Some hypotheses look less conclusive |
| Determinism vs. nuance in grading | Deterministic evaluators | Coarser judgments; calibration needed |
| Breadth of Qloo capabilities vs. reliability | Seven test kinds, each degrading independently | Some kinds may be unavailable live |
| Live data vs. availability during judging | Replay samples + a live quota guard | A storage-terms dependency (R-08) |
| Developer speed vs. infrastructure purity | Monolith + Postgres-only infrastructure | A single worker limits throughput |
| Model capability vs. cost | A capable default model with strict budgets | A per-run cost of roughly $0.5–1.5 (estimate, unmeasured) |
| Full counterfactual generality vs. clarity | Hold-fixed default | Regenerate mode deferred |
| Platform-level secret isolation vs. deployment simplicity | One service with process-level isolation (ADR-017) | A container-level compromise could expose worker secrets (mitigated by spend limits and the quota guard) |
| Model quality vs. cost and availability | Opus 5.5 primary, Sonnet 5.5 configurable fallback (ADR-018) | Fallback steps may be lower quality; recorded per invocation |

---

## 4. Unresolved questions

| # | Question | Blocking? | Resolution path |
|---|---|---|---|
| U-1 | Exact MCP tool input schemas and result item fields | **Resolved 2026-10-21** (V1; API_CONTRACTS §5.5) | — |
| U-2 | Event quota, rate limit, credential expiry | Yes, for budget tuning | Organizer publication / kit Q&A |
| U-3 | Is storing/replaying Qloo responses allowed? | Yes, for the samples | Qloo terms review; ask the organizers |
| U-4 | Official rules: video, criteria, eligibility | **Resolved 2026-10-20** (externally verified by the owner: deadline, individual participation, demo/repo/license/English requirements, video not mandatory, judging Nov 2–16, four equal criteria). Personal eligibility details remain for the owner to confirm. | HACKATHON_CHECKLIST §1.1 |
| U-5 | Entity type token format accepted by the harness (`urn:entity:book` vs `book`) | **Resolved 2026-10-21:** workflows take short names (`book`, `tv_show`, `videogame`, …); outputs use URNs; `qloo api search --type` accepts both aliases and URNs | — |
| U-6 | Does `qloo_recommend` support tag/location filters? | **Resolved 2026-10-21:** the schema supports `signal_tags`, `include_tags`/`exclude_tags` with operators, `signal_location`, `filter_location`, `demographic`. Tag signals were exercised live (LC-5b); location and demographic parameters were not exercised. | M2 live suite |
| U-7 | Is an MCP tool available for plain entity search, or only `qloo api search`? | **Resolved 2026-10-21:** only `qloo api search` | — |
| U-12 | Event quota, rate-limit error code, credential expiry (still unpublished) | Yes, for budget tuning | Organizers / kit Q&A |
| U-8 | The runtime LLM budget the owner will fund | Yes, for the hosted demo | The owner, by M3. Recommendation: $150 prepaid (ADR-018). |
| U-9 | Final hosting vendor choice (single service per ADR-017) | **Resolved 2026-10-21** as the engineering target: Fly.io + Neon; paid provisioning remains subject to owner authorization | ADR-016; hosted validation in M10 |
| U-10 | Does the hosting platform allow a root container start (needed for per-process UIDs)? | No (fallback: one non-root user + documented residual risk) | M0 / M10 |
| U-11 | Can the owner's API account access `claude-opus-5-5` and `claude-sonnet-5-5`? (IDs verified in the docs, not via a live call) | Yes, for M3 | Owner key → `GET /v1/models/{id}` in M3 |

---

## 5. Risk register

Likelihood and impact use H/M/L.

| ID | Risk | L | I | Mitigation | Owner | Trigger / check date |
|---|---|---|---|---|---|---|
| R-01 | The Qloo key arrives late or never | M | H | Fixture-based development; V1 prepared; escalation via kit channels; an honest public demo state (no fixtures in production) | Owner | Oct 26 |
| R-02 | Harness tool schemas differ from the assumptions | **Materialized and handled** (2026-10-21) | M | Differences documented in ADR-019 and API_CONTRACTS §5.5; evaluators redefined; normalizer mapping specified for M2 | Dev | Closed after M2 contract tests |
| R-03 | Event quota too small for judging traffic | M | H | Cache, the quota guard, replay samples, per-workspace limits | Dev | After the quota is published |
| R-04 | The schedule (10 days, solo) is too tight for all eight modules | H | H | A daily milestone plan; depth reductions (IMPLEMENTATION_PLAN §4); AI-assisted parallel work on M7/M9; a hard freeze | Owner | Daily |
| R-05 | Runtime LLM costs or provider access | M | M | ADR-018: cost model (≈ $1.09 per typical exploration on Opus 5.5), $150 prepaid budget with a Console spend limit, a global daily cap, the Sonnet 5.5 fallback / economy mode, replay samples at $0 | Owner | M3 |
| R-06 | Long agent runs feel slow | M | M | Live activity dock, early partial results, budgets, the samples-first onboarding | Dev | M6 |
| R-07 | Credential expires during judging | M | H | Ask the organizers (A5); replay samples keep the demo usable; a clear banner | Owner | Before submission |
| R-08 | Qloo terms restrict storing and replaying responses | M | H | A terms review; the live-on-demand contingency; minimize retention | Owner | Before seeding samples (M10) |
| R-09 | Devpost rules contain unmet requirements | L | H | Key rules externally verified 2026-10-20 (HACKATHON_CHECKLIST §1.1). The owner confirms personal eligibility. | Owner | Oct 22 |
| R-10 | Prompt injection or harmful outputs in public demo traffic | L | M | Data-block prompting; validators; no side-effecting tools; refusal handling; rate limits | Dev | M3/M10 |
| R-11 | Secret leakage when making the repository public | L | H | gitleaks full history; push protection; recording checklist | Owner | Oct 30 |
| R-12 | Hosting outage during judging | L | H | Health monitoring; a prepared alternate-platform deploy; always-on settings | Owner | Judging period |
| R-13 | Perceived as "just another recommender" | M | M | Demo flow centered on hypotheses, evidence, and the What-if Lab; originality doc | Owner | M11 |
| R-14 | Next.js/library version incompatibilities at scaffold time | L | M | Pin exact versions; M0 verifies the build in Docker | Dev | M0 |
| R-15 | Process-level secret isolation is weaker than separate services (ADR-017) | L | M | Env allowlists, UID separation, the web env deny-list, provider spend limits, the Qloo quota guard; the option to split via `TL_ROLE` | Dev | M10 |
| R-16 | Memory pressure from three Node processes in one container (web, worker, `qloo mcp`) | M | M | Start with 2 GB RAM; measure in M10; restart policy; heap limits per child (`--max-old-space-size`) | Dev | M10 |
| R-17 | "Design" is 25% of judging but at risk of being squeezed by backend work | M | H | Reserve UI polish time in M7/M9/M10; design acceptance in TEST_PLAN; no design work moved to stretch | Owner | Daily |
| R-18 | Cross-domain Qloo affinities can look culturally implausible for single seeds (V1 LC-5a/5b), which hurts perceived quality | M | M | Claim tests prefer combined entity and tag signals; per-seed threads labeled; relative-affinity evaluators; aggregate-affinity labeling; collision tension keeps selection deliberate | Dev | M6 |

---

## 6. Decision log (append below)

| Date | Decision / change | Reference |
|---|---|---|
| 2026-10-20 | Architecture baseline v1.0 created; ADR-001…ADR-016 recorded | This document |
| 2026-10-20 | Review: the hackathon rules facts recorded as externally verified (owner); judging criteria mapped | HACKATHON_CHECKLIST §1.1, §2.7 |
| 2026-10-20 | Review: the single-service deployment adopted (ADR-017); the two-app topology superseded | ADR-017 |
| 2026-10-20 | Review: model IDs verified against the official docs; fallback model, cost model, and credential requirements added; EXPLORATION and COMPOSITION cost caps raised to 2.00 / 0.70 | ADR-018, AGENT_WORKFLOW §7 |
| 2026-10-20 | Review: the Qloo access architecture re-verified (kit commit `80a82b2` unchanged; harness `0.1.26` latest) | API_CONTRACTS §5.0 |
| 2026-10-20 | Review: `.DS_Store` added to `.gitignore`; cross-document consistency fixes | IMPLEMENTATION_PLAN, DATABASE_SCHEMA, UI_UX_SPEC, TEST_PLAN |
| 2026-10-22 | M9 implemented: R6 blueprint composition with deterministic fact and constraint blocks, layered traceability validation (compose validator, VALIDATING_BLUEPRINT re-check), blueprint page (traceability meter, provenance chips, citations to evidence trace, constraints, appendix, in-place editing, section recompose, revision history with restore, accept), Markdown/JSON export, print stylesheet, hashed read-only share links (blueprint/experiment/project) with revoke, What-if branch composition; ADR-028 recorded | IMPLEMENTATION_PLAN M9 |
| 2026-10-22 | M8 implemented: counterfactual planner and comparison metrics in core, branch materialization with CACHE-labeled reuse, COUNTERFACTUAL run (gate H4, deterministic re-grading, R5 narrative with placeholder validation), What-if Lab (branch tree, variable editor with live preview, comparison view with charts and per-query diffs), Adjust weights → rescore-only branch, fixture traffic exempted from the live quota; ADR-027 recorded | IMPLEMENTATION_PLAN M8 |
| 2026-10-22 | M7 implemented: evidence graph (core projection, API, layout persistence, React Flow canvas with provenance encoding, filters, keyboard navigation, inspector with trace, equivalent List view) and the Activity Monitor full view (state durations, tool and LLM cost tables, complete timeline, reconnect indicator), cancelled/limited ribbon; ADR-026 recorded | IMPLEMENTATION_PLAN M7 |
| 2026-10-21 | M6 implemented: pool gate H2b with a client-side tension preview, evaluation ruleset `ruleset-2026.10-m6`, rule-based feasibility, salvage after a failed repair, planner tag signals, evidence rationale, Hypothesis Lab (cards, status groups, retired group, evidence drawer, trace, score breakdown, iteration timeline, gate H3); ADR-025 recorded | IMPLEMENTATION_PLAN M6 |
| 2026-10-21 | M5 implemented: Creative Brief (form, preview, H1 chips, versions), V1-based resolution with tags and locality (H2), budgeted tag enrichment, Discovery Canvas (lanes, list, inspector, trace), synthetic fixtures and scripted AI for development and E2E, fixture-firewall-through-cache fix; ADR-024 recorded | IMPLEMENTATION_PLAN M5 |
| 2026-10-21 | M4 implemented: state machine (core), pure step handlers, pg-boss worker with idempotent commits, budgets, cancellation, gates, expiry, recovery, retry, SSE, run API, heartbeat readiness; full scripted EXPLORATION passes; ADR-023 recorded | IMPLEMENTATION_PLAN M4 |
| 2026-10-21 | M3 implemented: provider-agnostic LLM gateway (Anthropic + scripted providers), prompt registry, repair/refusal/truncation/fallback/budget policies, §13.2 validators in `packages/agent`; ADR-022 recorded | IMPLEMENTATION_PLAN M3 |
| 2026-10-21 | M2 implemented: worker endpoint settings, live Qloo adapter (MCP/CLI routing, envelope parsing, normalizers, quota, cache, provenance), worker readiness and heartbeat; ADR-021 recorded; 3-call live smoke passed | API_CONTRACTS §6.7 |
| 2026-10-21 | M1 implemented: Zod domain schemas, Drizzle schema (28 tables), migrations, repositories; ADR-020 recorded | DATABASE_SCHEMA §11 |
| 2026-10-21 | V1 live Qloo validation (20 calls, hackathon endpoint); ADR-019 recorded; U-1, U-5, U-6, U-7 resolved; U-12 opened; R-02 handled; R-18 added | research/QLOO_V1_VALIDATION.md, API_CONTRACTS §5.5 |
