# Tessaloom — Architecture Decisions, Trade-offs, and Risks

> **Status:** v1.1 · 2026-10-20 (architecture review: ADR-017, ADR-018 added) · ADR format: Context → Decision → Alternatives → Consequences
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
  2. spawns **worker** (`node apps/worker/dist/main.js`) with the allowlist `NODE_ENV, APP_ENV, DATABASE_URL, QLOO_API_KEY, QLOO_HOME, QLOO_MODE, QLOO_RATE_LIMIT_PER_MIN, GLOBAL_DAILY_*, ANTHROPIC_API_KEY, LLM_PROVIDER, LLM_MODEL, LLM_FALLBACK_MODEL, LOG_LEVEL`, plus the same generated `PATH`. The worker spawns `qloo mcp` with its own env in M2. `PATH` is derived only from the running Node executable's directory and `/usr/local/bin`, `/usr/bin`, `/bin`, with duplicates removed; the parent's `PATH` is discarded. In the Docker image it is `/usr/local/bin:/usr/bin:/bin`, so both `qloo` and its `/usr/bin/env node` shebang resolve. No `NODE_OPTIONS`, `LD_PRELOAD`, or unrelated parent variables are forwarded.
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
| U-1 | Exact MCP tool input schemas and result item fields | Yes, for the evaluators | V1 (`listTools()` + recordings) |
| U-2 | Event quota, rate limit, credential expiry | Yes, for budget tuning | Organizer publication / kit Q&A |
| U-3 | Is storing/replaying Qloo responses allowed? | Yes, for the samples | Qloo terms review; ask the organizers |
| U-4 | Official rules: video, criteria, eligibility | **Resolved 2026-10-20** (externally verified by the owner: deadline, individual participation, demo/repo/license/English requirements, video not mandatory, judging Nov 2–16, four equal criteria). Personal eligibility details remain for the owner to confirm. | HACKATHON_CHECKLIST §1.1 |
| U-5 | Entity type token format accepted by the harness (`urn:entity:book` vs `book`) | Yes, for M5 | V1 |
| U-6 | Does `qloo_recommend` support tag/location filters? | Partly (test kinds degrade) | V1 |
| U-7 | Is an MCP tool available for plain entity search, or only `qloo api search`? | No (the CLI fallback exists) | V1 |
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
| R-02 | Harness tool schemas differ from the assumptions | M | H | Permissive normalizers, optional fields, per-test-kind degradation, a V1 spike | Dev | V1 |
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
