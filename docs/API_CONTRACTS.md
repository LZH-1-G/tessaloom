# Tessaloom — API Contracts (Internal APIs and Qloo Integration)

> **Status:** v1.2 · 2026-10-21. **V1 live validation completed** against `https://hackathon.api.qloo.com` (20 harness calls). Observed results are in [research/QLOO_V1_VALIDATION.md](research/QLOO_V1_VALIDATION.md) and summarized in §5.5. Where §5.3 (planning text) conflicts with §5.5 (observed), **§5.5 prevails**.
> **Legend:** ✅ **CONFIRMED (docs)**: stated in an official source we read on 2026-10-20 · 🟡 **PENDING LIVE VALIDATION**: plausible from the docs, but not yet exercised with a real credential · ⛔ **UNKNOWN**: not found in any accessible source
> **Rule:** No endpoint, parameter, response field, or score below should be treated as working until a live contract test has recorded it ([TEST_PLAN.md §5](TEST_PLAN.md#5-qloo-adapter-contract-tests)).

---

## 1. Overview

Tessaloom exposes two kinds of contracts:

1. **Internal REST + SSE API** (`/api/v1/*`), served by the web process. It is consumed by the Tessaloom UI and by E2E tests.
2. **Integration ports**, consumed by the worker:
   - `QlooPort`: cultural intelligence, the only path to Qloo;
   - `LlmPort`: structured generation, the only path to an LLM.
   - The worker also has **job contracts** (pg-boss payloads) and the **run event contract** (SSE).

---

## 2. Research sources and limitations

| Source | URL | Accessed | What we learned | Limitation |
|---|---|---|---|---|
| Official Qloo Hackathon Kit | https://github.com/qloo/qloo-hackathon-kit (commit `80a82b2`, 2026-10-20) | Cloned and read in full | Supported surfaces; harness install; MCP tool names; envelope statuses; error shape; safe-use rules; submission guide; "serverless not supported" | Tool **input schemas** and **result item fields** are not documented in the kit |
| `@qloo/qloo-harness` npm metadata | `npm view @qloo/qloo-harness` | 2026-10-20 | Latest `0.1.26`; `bin: qloo`; `engines: node >=22.19.0`; MIT; source repo `github.com/qloo/agentic-qloo` | The harness source repository returned **404** (likely private). We did not install or execute the package during the architecture phase. |
| Qloo API docs | https://docs.qloo.com/ (pages listed in §5.3) | 2026-10-20, through an automated fetch-and-summarize tool | Endpoint paths, parameter names, `X-Api-Key` header, pagination limits, some response fields | Several pages are partially rendered (item schemas are in referenced files that were not shown). Some examples conflict (for example, a 404 described with a `code: 400` body). **Exact field shapes must be confirmed live.** |
| Qloo docs MCP server | `https://docs.qloo.com/mcp` | Not connected during this phase | — | Can be used during implementation for `list-endpoints` / `get-endpoint`. **Never** use its `execute-request` tool (the kit forbids it). |
| **V1 live validation** | `https://hackathon.api.qloo.com` via `@qloo/qloo-harness` 0.1.26 (`qloo mcp`, `qloo exec`, `qloo api search`) | 2026-10-21, 20 calls | Tool schemas, envelope, error shapes, item fields, scores, type tokens, disambiguation behavior (§5.5) | Raw responses are not committed (R-08). Quota, rate-limit code, and expiry remain unknown. |
| Devpost rules | https://qloo.devpost.com/rules | **Not fetchable by the assistant** (HTTP 403 / Cloudflare challenge, re-checked 2026-10-20; no bypass attempted) | Key facts **externally verified by the owner** against the official page: a working application with **meaningful Qloo API integration** is required, among others | See [HACKATHON_CHECKLIST.md §1.1](HACKATHON_CHECKLIST.md#11-rules-facts-confirmed-from-the-official-rules-externally-verified) |

**Important consequence.** The kit lists the event's supported surfaces as the harness commands. The REST endpoints under `api.qloo.com` describe Qloo's public API, but Tessaloom reaches them **only indirectly**, through the harness workflows or `qloo api`. Which REST parameters each harness workflow exposes is 🟡 PENDING LIVE VALIDATION.

---

## 3. Internal REST API conventions

### 3.1 General

- **Base path and versioning.** Base path `/api/v1`. Breaking changes require `/api/v2`.
- **Format.** JSON (`application/json; charset=utf-8`). Field names are camelCase. Timestamps are ISO 8601 UTC. IDs are UUIDv7 strings.
- **Validation.** Every request body, query, and response is validated with Zod (`packages/core/src/api/*`). Responses are validated in development and test, and sampled in production.
- **Authentication.** A workspace cookie: `tl_ws`, httpOnly, Secure, SameSite=Lax, containing a random 256-bit secret. The server stores only an HMAC-SHA-256 of it. A cookie is issued on first visit. No accounts or emails are required ([SECURITY.md §4](SECURITY.md#4-identity-access-and-share-links)).
- **CSRF protection.** Mutating requests require the header `X-Tessaloom-CSRF`, matching a double-submit cookie, and an `Origin` check.
- **Idempotency.** Run-starting endpoints accept `Idempotency-Key` (UUID). The same key with the same body within 24 h returns the original response.
- **Rate limits.** Run-starting endpoints are limited to 6 per minute per workspace and 20 per minute per IP. Other mutations are limited to 60 per minute per workspace. Exceeding a limit returns `429 RATE_LIMITED` with `Retry-After`.
- **Pagination.** Cursor-based: `?limit=20&cursor=<opaque>`, returning `{ items, nextCursor }`.

### 3.2 Success envelope

Resources are returned directly, with no wrapper. Lists use `{ items: T[], nextCursor: string | null }`.

### 3.3 Error envelope

```json
{
  "error": {
    "code": "QUOTA_GUARD_ACTIVE",
    "message": "Live experiments are paused for today to protect the shared Qloo quota. Sample projects remain available.",
    "retryable": false,
    "requestId": "01J…",
    "details": {}
  }
}
```

| HTTP | `code` examples |
|---|---|
| 400 | `VALIDATION_FAILED` (with `details.issues[]` from Zod) |
| 401 | `WORKSPACE_REQUIRED` |
| 403 | `FORBIDDEN`, `CSRF_FAILED`, `SHARE_LINK_REVOKED` |
| 404 | `NOT_FOUND` |
| 409 | `STATE_CONFLICT` (for example, confirming a run that is not awaiting confirmation), `IDEMPOTENCY_MISMATCH` |
| 422 | `BRIEF_INSUFFICIENT` (fewer than 2 interests), `DELTA_EMPTY` |
| 429 | `RATE_LIMITED`, `QUOTA_GUARD_ACTIVE` |
| 503 | `WORKER_OFFLINE`, `QLOO_UNAVAILABLE`, `LLM_UNAVAILABLE` |

---

## 4. Internal endpoint catalog

### 4.1 Workspace and projects

| Method & path | Purpose | Request | Response |
|---|---|---|---|
| `GET /api/v1/workspace` | Current workspace summary | — | `{ id, createdAt, projectCount, dailyRunsRemaining }` |
| `GET /api/v1/projects` | List projects (dashboard) | `?status=active\|archived&limit&cursor` | `{ items: ProjectSummary[], nextCursor }` |
| `POST /api/v1/projects` | Create a project | `{ name (1–80), useCase: "bookstore"\|"cafe"\|"venue"\|"community_event"\|"other" }` | `201 Project` |
| `POST /api/v1/projects/from-sample` | Fork a sample project (replay data) | `{ sampleId }` | `201 Project` |
| `GET /api/v1/projects/:projectId` | Project detail | — | `Project` (+ current brief, latest experiment) |
| `PATCH /api/v1/projects/:projectId` | Rename or archive | `{ name?, status? }` | `Project` |
| `GET /api/v1/projects/:projectId/export` | Export the full project bundle | `?format=json` | `application/json` (`ProjectExportV1`) |

### 4.2 Creative briefs

| Method & path | Purpose | Request | Response |
|---|---|---|---|
| `POST /api/v1/projects/:projectId/briefs` | Create a new brief **version** (append-only) | `BriefInput` (below) | `201 BriefVersion` |
| `GET /api/v1/projects/:projectId/briefs` | List versions | — | `{ items: BriefVersionSummary[] }` |
| `GET /api/v1/briefs/:briefVersionId` | Get a version | — | `BriefVersion` |

```ts
type BriefInput = {
  title: string;                       // 1–120
  challenge: string;                   // 20–2000; free text
  interests: { text: string; domainHint?: Domain }[]; // 2–6
  venue: { type: VenueType; localityText?: string; capacity?: number /* 1–5000 */ };
  constraints: { budgetBand?: "low"|"medium"|"high"; durationMinutes?: number; notes?: string[] };
  goals: string[];                     // 0–5, each ≤ 140
};
type Domain = "artist"|"book"|"brand"|"destination"|"movie"|"person"|"place"|"podcast"|"tv_show"|"video_game";
```

The `Domain` values follow the Insights entity categories listed in the docs. Whether the harness accepts these exact type tokens or full URNs (`urn:entity:*`) is 🟡 PENDING.

### 4.3 Experiments and runs

| Method & path | Purpose | Request | Response |
|---|---|---|---|
| `POST /api/v1/projects/:projectId/experiments` | Start an EXPLORATION experiment | `{ briefVersionId, variables?: ExperimentVariablesInput, scoringWeights?, mode: "live" }` + `Idempotency-Key` | `202 { experimentId, experimentKey, runId, reused: boolean }` |
| `GET /api/v1/experiments/:experimentId` | Experiment detail (read model) | — | `ExperimentView` (variables, seeds, hypotheses with status/scores, runs) |
| `GET /api/v1/experiments/:experimentId/graph` | Evidence graph projection | `?include=entities,hypotheses,evidence,experiments` | `GraphView { nodes: GraphNode[], edges: GraphEdge[], layout? }` |
| `PUT /api/v1/experiments/:experimentId/graph-layout` | Save node positions | `{ positions: { nodeId, x, y }[] }` | `204` |
| `POST /api/v1/experiments/:experimentId/revalidate` | Live re-run of the stored evidence plan | `Idempotency-Key` | `202 { runId }` |
| `GET /api/v1/runs/:runId` | Run status | — | `RunView { state, kind, iteration, budget, usage, pendingConfirmation, terminalReason }` |
| `GET /api/v1/runs/:runId/events` | **SSE** stream of run events | `Last-Event-ID` header or `?after=<seq>` | `text/event-stream` (§10) |
| `POST /api/v1/runs/:runId/confirmations` | Answer a human gate | `ConfirmationResponse` (below) | `202 RunView` |
| `POST /api/v1/runs/:runId/cancel` | Cancel | — | `202 RunView` |
| `POST /api/v1/runs/:runId/retry` | Retry the last failed transient step | — | `202 RunView` or `409` |

```ts
type ConfirmationResponse =
  | { kind: "BRIEF"; briefVersionId: UUID; action: "confirm" }
  | { kind: "ENTITIES"; selections: { interestIndex: number; choice:
        | { type: "candidate"; candidateId: UUID }
        | { type: "refine"; text: string }
        | { type: "exclude" } }[] }
  | { kind: "POOL"; tension: number /* 0.2–0.9, gate H2b (ADR-025) */ }
  | { kind: "HYPOTHESIS_SELECTION"; selectedHypothesisIds: UUID[] /* 0–3 */ }
  | { kind: "COUNTERFACTUAL_COST"; action: "run" | "cancel"; maxQlooCalls?: number };
```

### 4.4 Hypotheses and evidence

| Method & path | Purpose | Response |
|---|---|---|
| `GET /api/v1/hypotheses/:hypothesisId` | Hypothesis with claims, stances, score breakdown, and lineage | `HypothesisView` |
| `GET /api/v1/hypotheses/:hypothesisId/evidence` | Evidence records for all claims | `{ items: EvidenceView[] }` |
| `GET /api/v1/evidence/:evidenceId` | One evidence record | `EvidenceView` |
| `GET /api/v1/evidence/:evidenceId/trace` | **Request-to-result trace**: redacted tool request, envelope status/summary, the exact JSON pointer and value used, evaluator rule and version, data origin, retrieval time | `EvidenceTrace` |
| `PATCH /api/v1/hypotheses/:hypothesisId` | User annotations only (pin, note) | `HypothesisView` |

`EvidenceTrace` directly supports submission-guide item 3 (*"A redacted request-to-result explanation, including any entity/tag choices"*).

### 4.5 Counterfactual branches and comparisons

| Method & path | Purpose | Request | Response |
|---|---|---|---|
| `POST /api/v1/experiments/:experimentId/branches` | Create a counterfactual branch | `{ delta: VariableDelta, mode: "hold_hypotheses" \| "regenerate", label?: string }` | `202 { branchExperimentId, experimentKey, runId, plannedDirtyQueries, reusedQueries }` |
| `GET /api/v1/experiments/:experimentId/branches` | List child branches | — | `{ items: BranchSummary[] }` |
| `POST /api/v1/comparisons` | Compare any two experiments in a project | `{ baseExperimentId, otherExperimentId }` | `201 ComparisonView` (metrics are computed synchronously; the narrative is optional and asynchronous) |
| `GET /api/v1/comparisons/:comparisonId` | Get a comparison | — | `ComparisonView { metrics, perQuery[], perHypothesis[], narrative?, dirtyQueries, reusedQueries, newQlooResults }` |

```ts
type VariableDelta = {
  seeds?: { add?: string[] /* resolved entity UUIDs */; remove?: string[]; swap?: { from: string; to: string }[] };
  targetDomains?: { add?: Domain[]; remove?: Domain[] };
  tagConstraints?: { add?: string[]; remove?: string[] };
  location?: { localityEntityId: string } | null;
  audienceBand?: { ageBand: "18-24"|"25-34"|"35-44"|"45-54"|"55+" } | null; // aggregate only
  timeWindow?: { weeks: 4 | 12 | 26 | 52 };
  collisionTension?: number;             // 0.2–0.9
  scoringWeights?: { support: number; novelty: number; feasibility: number }; // sum = 1
  constraints?: Partial<BriefInput["constraints"] & { capacity: number }>;
};
```

Adding a new seed that is not yet resolved requires a resolution step first: `POST /api/v1/projects/:projectId/resolve` (§4.7).

### 4.6 Blueprints and sharing

| Method & path | Purpose | Request | Response |
|---|---|---|---|
| `POST /api/v1/experiments/:experimentId/blueprints` | Start a COMPOSITION run | `{ hypothesisIds: UUID[] /* 1–3 */, format: "event" \| "series" \| "installation" }` | `202 { blueprintId, runId }` |
| `GET /api/v1/blueprints/:blueprintId` | Current revision | — | `BlueprintView` |
| `GET /api/v1/blueprints/:blueprintId/revisions` | Revision history | — | `{ items: BlueprintRevisionSummary[] }` |
| `POST /api/v1/blueprints/:blueprintId/revisions` | Save a user edit as a new revision | `{ baseRevisionId, content: BlueprintContent }` | `201 BlueprintRevision` or `409 STATE_CONFLICT` if the base is stale |
| `POST /api/v1/blueprints/:blueprintId/sections/:sectionKind/recompose` | Recompose one section | `{ instruction?: string /* ≤ 300 */ }` | `202 { runId }` |
| `GET /api/v1/blueprints/:blueprintId/export` | Export | `?format=md\|json` | File download. `md` includes an evidence appendix and provenance legend. PDF is produced through a print stylesheet in the browser. |
| `POST /api/v1/projects/:projectId/share-links` | Create a read-only share link | `{ scope: "project" \| "experiment" \| "blueprint", targetId, expiresInDays?: 1–90 }` | `201 { shareLinkId, url }` (the token is shown **once**) |
| `DELETE /api/v1/share-links/:shareLinkId` | Revoke | — | `204` |
| `GET /api/v1/share/:token` | Read-only payload for the share page | — | `SharedView` (no workspace data, no run controls) |

### 4.7 Entity resolution (ad hoc)

| Method & path | Purpose | Request | Response |
|---|---|---|---|
| `POST /api/v1/projects/:projectId/resolve` | Resolve free text to candidate entities or tags (used by the What-if Lab "swap" and "add" controls) | `{ text: string, domainHint?: Domain, kind: "entity" \| "tag" }` | `202 { resolutionId }`, then poll `GET /api/v1/resolutions/:id` → `ResolutionView { status, candidates[] }` |

This runs as a tiny worker job (`resolve.entity`) because only the worker can reach Qloo. It is counted against the workspace and global Qloo quotas.

### 4.8 Health

| Path | Response |
|---|---|
| `GET /api/health` | `200 { status: "ok", version }` |
| `GET /api/health/ready` | `200` if the DB is reachable **and** the worker heartbeat is < 30 s old. Otherwise `503` with `{ db, worker }`. |
| `GET /api/health/qloo` | `{ adapterReady: boolean, transport, harnessVersion, checkedAt, mode: "live"\|"fixture" }`. Comes from the worker's last `qloo_capabilities` check. Contains no secrets. |

---

## 5. Qloo integration contracts

### 5.0 Access architecture verification (review of 2026-10-20)

**Result: the planned integration uses only the hackathon-supported harness interfaces.** No direct REST client to `api.qloo.com` is planned (ADR-003). The kit repository was re-checked (latest commit `80a82b2`, unchanged), and npm still lists `@qloo/qloo-harness` `0.1.26` as the latest version.

| Planned path | Supported per kit? | Evidence (kit file) | Tessaloom usage | Live status |
|---|---|---|---|---|
| `qloo mcp` (stdio MCP server) via `@modelcontextprotocol/sdk` | ✅ Yes | README route table; `starter/mcp-client/README.md` §4–§6; `backend.mjs`; `manifest.json` `supported_surfaces` | **Primary.** A persistent child of the worker process, spawned with `env: process.env` | ✅ **VERIFIED 2026-10-21** (10 tools; LC-0, LC-12) |
| `qloo exec <workflow> --input-file` | ✅ Yes | README; `starter/cli-workflow/README.md` | Secondary transport / fallback for workflows | ✅ **VERIFIED 2026-10-21** (all 9 workflows exercised) |
| `qloo api <command> --json` (for example `search`) | ✅ Yes | README; `starter/cli-workflow/README.md` | **Required** for entity search (no search workflow exists) and for locality disambiguation strings | ✅ **VERIFIED 2026-10-21** (LC-1, LC-15). Its `--dry-run` URL ignores `QLOO_BASE_URL` (display-only quirk). |
| `qloo explore` (chat agent) | ✅ Supported, but **not used at runtime** | README | Optional for the owner's manual exploration only; never in the deployed app | — |
| Credential via `QLOO_API_KEY` env on servers | ✅ Yes | MCP starter §1, §6; TROUBLESHOOTING | Worker-only env (ADR-017 allowlist) | ✅ Key received. Locally configured via the harness private config (`source: config`); env-based server use is verified in M2. |
| Hackathon endpoint via `QLOO_BASE_URL` + `QLOO_TRUSTED_BASE_URL` = `https://hackathon.api.qloo.com` | ✅ Harness-supported (custom base URL is refused unless trusted) | Harness `doctor` / `router.js` | Must reach the worker and its `qloo mcp` child. **Not in the M0 worker allowlist → M2 prerequisite** (ADR-019) | ✅ **VERIFIED** on the wire (LC-1 `--verbose`) |
| Long-running container, Node ≥ 22.19, harness installed | ✅ Required | MCP starter §6 (*"Serverless functions are not a supported route"*) | Single always-on container service (ADR-017) | Verified in M0 (`qloo --version` in the image) |
| Docs MCP server `https://docs.qloo.com/mcp` | Reference only | README, API_ACCESS.md | Development-time lookup only; **never** `execute-request`; never deployed | — |
| Direct REST (`api.qloo.com`, `X-Api-Key`) | ❌ Not a listed event surface (only "an organizer-approved authenticated gateway") | API_ACCESS.md | **Not used** | — |
| Hosted Qloo API MCP endpoints; legacy `qloo api mcp`; `integrate/plan/build` modes | ❌ Excluded | `manifest.json` `excluded_components`; README | **Not used** | — |

**Documented vs. awaiting credentials.** Each harness capability is classified as follows:

- **Documented (✅):** tool names, the result envelope shape, the statuses, the `error.code` / `retryable` / `recovery` fields, `QLOO_AUTH`, the `find_tags` inputs (`query`, `limit` 1–20), and the input names listed in the kit's tool table.
- **Awaiting live credentials (🟡):** full input schemas, result item fields, scores, filters, rate-limit error codes, and latencies. These are resolved in milestone V1 (TEST_PLAN §5.2).
- **V1 outcome (2026-10-21):** input schemas, item fields, scores, filters, latencies, and the `QLOO_AUTH`/`QLOO_CONTRACT` error shapes are now observed (§5.5). Still ⛔ unknown: the rate-limit error code, the event quota, and credential expiry.

**Mock policy.** Mock or fixture results are **never** returned as production Qloo results. `FixtureTransport` cannot be constructed in production, there is no code path from a live transport to fixtures, and fixture-derived records carry `DEVELOPMENT_FIXTURE` provenance (§6.4, ADR-014).

### 5.1 Access model ✅

| Aspect | Contract | Source |
|---|---|---|
| Supported surfaces | `qloo explore`, `qloo exec`, `qloo api`, `qloo mcp` from `@qloo/qloo-harness` (≥ 0.1.26) | Kit README, `docs/API_ACCESS.md`, `manifest.json` |
| Excluded | Harness `integrate` / `plan` / `build` modes; *hosted Qloo API MCP endpoints*; *legacy `qloo api mcp` server*; the docs-MCP `execute-request` tool | Kit `manifest.json`, README, `docs/API_ACCESS.md` |
| Credential | Event-issued and individually attributable. Configured via `qloo setup --qloo` or the `QLOO_API_KEY` environment variable on servers. **Never** passed as `--api-key` (it would leak to shell history). | Kit `starter/cli-workflow/README.md`, MCP starter |
| Deployment | *"Run your backend on a VM or container that has Node.js 22.19 or newer, the harness installed, and `QLOO_API_KEY` set as a secret."* *"A browser cannot start `qloo mcp`. Serverless functions are not a supported route."* | MCP starter §6 |
| Readiness | `qloo_capabilities` reports readiness **without calling Qloo**. `qloo setup --status --json` and `qloo doctor` are non-mutating checks. | MCP starter, TROUBLESHOOTING |
| Quota and limits | *"Organizers must publish the event quota, rate limit, expiration time, and support/escalation path"*. The access system returns clear auth or rate-limit errors with no silent fallback. | `docs/API_ACCESS.md`. Values are ⛔ UNKNOWN to us. |
| Usage etiquette | *"Use the smallest request that can answer the product question. Cache only what your project needs, respect the event quota, and make retry behavior bounded."* No bulk scraping. | `docs/API_ACCESS.md` |
| Underlying REST auth | The `X-Api-Key` header on `https://api.qloo.com` (the docs also show `staging.api.qloo.com`). Handled inside the harness; Tessaloom does not send it. | docs: API Onboarding, endpoint pages |

### 5.2 Harness result envelope ✅ (shape) / 🟡 (item contents)

The MCP starter documents one envelope shape:

```json
{ "status": "ok" | "empty" | "needs_input" | "partial" | "degraded" | "error",
  "summary": "…",
  "results": [],
  "result_count": 0,
  "error": { "code": "QLOO_AUTH", "retryable": false, "recovery": "…" } }
```

- `error` is present only when `status = "error"`. *"Retry only when `error.retryable` is `true`."*
- `qloo exec` returns *"the same result shape"* as `qloo mcp`. `qloo api` returns the *raw API response*.
- The **fields inside `results[]` items are not documented** in the kit. ~~🟡 PENDING LIVE VALIDATION~~ → **observed in V1** (§5.5.3).
- Known error code: `QLOO_AUTH` (missing or rejected credential). Other codes are ⛔ UNKNOWN. **V1:** `QLOO_CONTRACT` was also observed (§5.5.2).

**V1-observed envelope (2026-10-21), which supersedes the sketch above:**

- **Success** (`qloo exec` and `qloo mcp` `structuredContent`):
  - **Always:** `schema_version` (`"1.0-preview.1"`), `operation`, `status`, `execution { transport: "direct"|"mcp", transport_name, correlation_id, duration_ms }`, `query_intent`.
  - **Usually:** `interpretation`, `resolution`, `provenance { source, endpoint, transport, documentation, requests[{ method, path, query }] }`, and `results` (array, or an **object** for `compare_audiences`) *or* `series` (trends), plus `result_count` and `explainability` (recommend).
  - **On `needs_input`:** `summary`, `results: []`, and `resolution.issues[]` instead of `outcomes[]`.
- **Failure** (`qloo exec`): a **bare object** `{ error: { code, layer, retryable, recovery }, operation, correlation_id }`, with **no** `status`, `execution`, or `provenance`, and a non-zero exit (`QLOO_AUTH` → 4, `QLOO_CONTRACT` → 1). The adapter maps a bare error object to `QlooOutcome.ERROR` and a missing `status` without `error` to `UNKNOWN_ENVELOPE`.

**Status mapping in the adapter:**

| Envelope `status` | `QlooOutcome.kind` | Evidence usable? | Agent behavior |
|---|---|---|---|
| `ok` | `OK` | Yes | Normal |
| `empty` | `EMPTY` | Yes (as absence) | Evaluator decides; usually INSUFFICIENT |
| `needs_input` | `NEEDS_INPUT` (with candidates if present) | No | Resolution → gate H2; evidence → claim INCONCLUSIVE |
| `partial` | `OK` with `quality: "PARTIAL"` | Yes, flagged | The flag is shown in the UI and stored on the evidence record |
| `degraded` | `OK` with `quality: "DEGRADED"` | Yes, flagged | Same; the critic is told about the quality reduction |
| `error` | `ERROR { code, retryable, recovery }` | No | Retry policy ([AGENT_WORKFLOW.md §10](AGENT_WORKFLOW.md#10-retry-policies-and-error-recovery)) |
| missing/unknown `status` | `ERROR { code: "UNKNOWN_ENVELOPE" }` | No | Same handling as the kit's `backend.mjs` example (treat as error) |

### 5.3 Planned integrations (capability by capability)

Each subsection follows the same template: purpose, inputs, expected output categories, docs, auth, failure handling, rate limits, caching, validation, and whether live testing is required. **Every row requires real-credential testing before it is considered working.**

> **V1 note (2026-10-21):** this section records the pre-validation plan. The observed inputs, outputs, and verdicts are in **§5.5**, which prevails on any conflict. In particular, there is no search workflow (use `qloo api search`); `compare_audiences` returns tag profiles, not a score; `where_popular` returns intra-city geohash cells; and `trends` rejects `book`.

#### 5.3.1 Readiness — `capabilities()`

| Field | Value |
|---|---|
| Purpose | Worker boot check, `/api/health/qloo`, "agent offline" banner |
| Harness tool | `qloo_capabilities` ✅ (kit MCP starter, `backend.mjs`) |
| Inputs | none (`{}`) ✅ |
| Output categories | Readiness info. `backend.mjs` reads `structuredContent.adapter.ready` ✅. Other fields are 🟡. |
| Docs | Kit `starter/mcp-client/README.md` §2, `backend.mjs` |
| Auth | Inherits `QLOO_API_KEY`. Does **not** call Qloo. |
| Failure handling | `ready=false` → adapter `NOT_READY` → live runs refused with `QLOO_UNAVAILABLE` |
| Rate limits | None (no Qloo call) |
| Caching | Result cached in memory for 60 s |
| Validation | `adapter.ready` must be boolean |
| Live testing required | **Yes** (verify the field path) |

#### 5.3.2 Cultural entity search — `searchEntities(text, types?, take?)`

| Field | Value |
|---|---|
| Purpose | Resolve brief interests to Qloo entities (role R2) |
| Transport | `qloo api search --query <text> [--type <type>] [--take <n>] --json` ✅ (examples in the kit CLI starter). Whether an MCP tool for plain entity search exists is 🟡; `qloo_describe` may cover it. The full command list is available from `qloo api --help` 🟡. |
| Underlying REST | `GET /search` with `query`, `types` (array of `urn:entity:*`), `filter.location`, `filter.radius`, `filter.tags`, `page` (1–100), `take` (< 200), `sort_by` (`match`\|`distance`\|`popularity`) ✅ (docs: Get Search) |
| Inputs (Tessaloom) | `text` (1–120 characters), optional `domainHint`, `take` default 5 |
| Output categories | A candidate entity list: ID, name, type(s), and descriptive properties 🟡. The item schema is in referenced files that the docs page did not render. |
| Docs | https://docs.qloo.com/reference/get-search |
| Auth | Via the harness |
| Failure handling | `404`/`empty` → `UNRESOLVED`, ask the user to refine (gate H2). Error → retry policy. |
| Rate limits | The docs list HTTP 429 for this endpoint ✅. The quota is ⛔. |
| Caching | 7 days by `requestHash`. Entity identity is stable; still 🟡. |
| Validation | Each candidate must have a non-empty ID and name, otherwise it is discarded and logged. Fuzzy matches are **never auto-selected** unless there is exactly one candidate whose normalized name equals the input and whose type matches the hint. |
| Live testing required | **Yes.** Confirm the CLI flags, `--type` token format, and response fields. |

#### 5.3.3 Entity identification and disambiguation — `describeEntity(ref)` / `getEntities(ids)`

| Field | Value |
|---|---|
| Purpose | Show disambiguating details at gate H2; refresh entity snapshots |
| Transport | MCP `qloo_describe` (kit: *"describe an entity"*) ✅ name / 🟡 inputs and outputs |
| Underlying REST | `GET /entities` with `entity_ids` (UUID array) and many `external.*.ids` filters (for example `external.wikidata.ids`, `external.isbn13.ids`) ✅ (docs: Get Entities) |
| Inputs | A Qloo entity ID (or a name, if `qloo_describe` accepts text) 🟡 |
| Output categories | Entity detail: type-specific properties 🟡; tags 🟡 |
| Docs | https://docs.qloo.com/reference/get-entities |
| Failure handling | Error → the candidate is shown without details, flagged "details unavailable" |
| Caching | 7 days |
| Validation | The returned ID must equal the requested ID |
| Live testing required | **Yes** |

#### 5.3.4 Tags and classifications — `findTags(query, limit)` and `entityTags(entity)`

| Field | Value |
|---|---|
| Purpose | Resolve thematic interests (for example "cozy mystery") to Qloo tags; read entity tags for novelty and the `TAG_RESONANCE` and `CROSS_DOMAIN_AFFINITY` evaluators |
| Transport | MCP `qloo_find_tags` ✅ with `{ query, limit }` ✅ (`backend.mjs`); CLI `qloo exec find_tags --input-file request.json` with `{"query": "...", "limit": 1–20}` ✅. MCP `qloo_entity_tags` ✅ name / 🟡 inputs and outputs. |
| Underlying REST | `GET /v2/tags` with `filter.query`, `filter.tag.types`, `filter.parents.types`, `feature.typo_tolerance`, `take` (max 50), `page` ✅; `feature.semantic_search` is beta ✅ (docs: Search Tags) |
| Output categories | Tag candidates (ID/URN, name, type 🟡). Tag URNs follow the `urn:tag:<type>:<namespace>:<value>` pattern seen in the docs examples (for example `urn:tag:genre:place:restaurant:italian`) ✅ as examples. |
| Docs | https://docs.qloo.com/reference/get-tags, kit CLI starter |
| Failure handling | The kit warns: *"A semantic search result is a candidate, not proof that the tag matches your product meaning… Do not pass an uncertain tag into later requests."* → tags always go through gate H2 unless they are an exact name match. |
| Caching | 7 days |
| Validation | `limit` 1–20 (kit) |
| Live testing required | **Yes** |

#### 5.3.5 Cross-domain insights and recommendations — `recommend(signals, targetType, options?)`

| Field | Value |
|---|---|
| Purpose | Core of discovery threads (§16 of AGENT_WORKFLOW) and the `CROSS_DOMAIN_AFFINITY` test |
| Transport | MCP `qloo_recommend` with `signals` and `target_type` ✅ (kit table: *"Fans of X also like…"*). Additional options such as tag filters, location, take, and demographics are 🟡. |
| Underlying REST | `GET /v2/insights` with required `filter.type`. Signals: `signal.interests.entities`, `signal.interests.tags`, `signal.demographics.age`, `signal.demographics.gender`, `signal.demographics.audiences`, `signal.location`, `signal.location.query`, plus weights. Filters such as `filter.tags`, `filter.exclude.tags`, `filter.popularity.min/max`, location filters, and type-specific filters. `take` default 20 / max 50; `page` 1–100; `feature.explainability` ✅ (docs: Insights deep dive, parameters-by-entity-type). |
| Supported `filter.type` | artist, book, brand, destination, movie, person, place, podcast, tv_show, videogame, `urn:heatmap`, `urn:tag`; locality is partial; audience is deprecated ✅ (docs). The exact URN spelling for video games (`videogame` vs `video_game`) is 🟡. Destination requires `signal.interests.entities` ✅. |
| Output categories | Ranked entities of the target type. The docs describe an **affinity score (0 to +1)** and a **popularity** percentile within the category ✅ (Insights API guide). Whether and where the harness envelope exposes them is 🟡. With `feature.explainability=true`, the REST API adds `query.explainability` with per-input influence ✅ (docs), but harness exposure is 🟡. |
| Docs | https://docs.qloo.com/docs/insights-api · https://docs.qloo.com/reference/insights-api-deep-dive · https://docs.qloo.com/reference/available-parameters-by-entity-type |
| Failure handling | `empty` → evaluator INSUFFICIENT. `partial`/`degraded` → flagged. `error` → retry policy. |
| Rate limits | ⛔ event quota. Default per-run cap is 40 calls (AGENT_WORKFLOW §7). |
| Caching | 24 h by `requestHash`. Affinity can drift, so live revalidation exists. |
| Validation | `targetType` must be in the supported list; 1–5 signals per call (Tessaloom limit); entity IDs must be resolved and confirmed. |
| Live testing required | **Yes.** This is the highest-priority validation. |

#### 5.3.6 Shortlist ranking — `rank(options, optionType, signals | demographic)`

| Field | Value |
|---|---|
| Purpose | `SHORTLIST_FIT` test; the blueprint composer chooses among candidate programming elements |
| Transport | MCP `qloo_rank` with `options`, `option_type`, and `signals` or `demographic` ✅ (kit table) |
| Underlying REST | Likely Insights with `filter.results.entities` (an explicit candidate list) ✅ as a parameter; the mapping is 🟡 |
| Output categories | Ordered options with scores 🟡 |
| Failure handling / caching / validation | As in §5.3.5; options 2–20 (Tessaloom limit) |
| Live testing required | **Yes** |

#### 5.3.7 Audience comparison — `compareAudiences(groupA, groupB)`

| Field | Value |
|---|---|
| Purpose | `AUDIENCE_BRIDGE` test: do two fan bases share enough affinity to meet in one experience? |
| Transport | MCP `qloo_compare_audiences` with `group_a`, `group_b` ✅ (kit table: *"How do two fan bases differ?"*) |
| Underlying REST | `GET /v2/analysis/compare` with **required** `a.signal.interests.entities`, `b.signal.interests.entities`. Optional `filter.type`, `filter.subtype` (`urn:tag:occupation`\|`urn:tag:genre`), `model` (`descriptive`\|`predictive`), `take` (max 50), `page`, location parameters ✅ (docs: Analysis Compare) |
| Output categories | Per the docs: "Analyze and compare two groups of entities"; results are an entity array ✅; comparison metrics are 🟡 |
| Validation | Each group needs 1–5 confirmed entity IDs |
| Evaluator | Thresholds are **not defined until live outputs are observed**. Until then, `AUDIENCE_BRIDGE` claims return INSUFFICIENT with the note "evaluator pending live calibration". |
| Live testing required | **Yes** |

#### 5.3.8 Audience demographics — `audienceDemographics(entities)`

| Field | Value |
|---|---|
| Purpose | Aggregate audience context for blueprint "Audience" sections (descriptive only) |
| Transport | MCP `qloo_audience_demographics` ✅ name (kit: *"Who is this audience?"*); inputs and outputs 🟡 |
| Responsible use | Aggregate only. The kit SAFE_USE guide says results *"should not be used to infer a person's identity, sensitive traits…"* and affinities are not causal claims. The UI shows a standing caveat. Not used to exclude groups. |
| Note | The REST `GET /v2/audiences` endpoint is marked **deprecated** in the docs ✅. Tessaloom does not call it directly. |
| Live testing required | **Yes** |

#### 5.3.9 Location-related insights — `wherePopular(entity, within)`

| Field | Value |
|---|---|
| Purpose | `LOCATION_FIT` test; the blueprint "Logistics/Promotion" sections |
| Transport | MCP `qloo_where_popular` with `entity` and `within` ✅ (kit table: *"Where should a pop-up or tour go?"*) |
| Underlying REST | Likely Insights with `filter.type=urn:heatmap` and/or locality parameters (`filter.location`, `filter.location.query`, `filter.location.radius`, `output.heatmap.boundary`) ✅ as parameters; the mapping is 🟡 |
| Inputs | One confirmed entity; `within` = a locality (name or Qloo locality ID) 🟡 |
| Output categories | Geographic areas with relative popularity 🟡 |
| Validation | Locality text must resolve to a locality (the docs say `filter.location.query` resolves locality names) 🟡 |
| Live testing required | **Yes** |

#### 5.3.10 Trends — `trends(entityType, entities[1..5], dateRange)`

| Field | Value |
|---|---|
| Purpose | `MOMENTUM` test (timeliness) |
| Transport | MCP `qloo_trends` with `entity_type`, one to five entities, and a date range ✅ (kit table) |
| Underlying REST | `GET /v2/trending` with required `filter.type`, `filter.start_date`, `filter.end_date` (YYYY-MM-DD); optional `signal.interests.entities`, `take` (max 50), `page`. Response `results.trending[]` with `date`, `population_percentile`, `population_rank`, `population_rank_velocity`, `velocity_fold_change`, `population_percent_delta`; weekly, sorted by date descending ✅ (docs: Get Trending Data) |
| Evaluator | SUPPORTS if the latest-week `population_rank_velocity` or `velocity_fold_change` indicates growth relative to the window start. The exact rule is fixed after live field confirmation 🟡. |
| Caching | 24 h |
| Live testing required | **Yes** |

### 5.4 Capability coverage summary

| Capability family (requirement) | Planned method | Harness exposure (observed) | Overall (V1, 2026-10-21) |
|---|---|---|---|
| Cultural entity search | `searchEntities` | `qloo api search` → `/search` (no workflow) | ✅ **CONFIRMED** (LC-1, LC-15) |
| Identification and disambiguation | `describeEntity` | `qloo_describe` → `/search` + `/entities`; `needs_input` with candidates | ✅ **CONFIRMED, with caveats**: "exact" may pick a minor edition; locality candidates need `/search` disambiguation (LC-3, 13–15) |
| Tags and classifications | `findTags`, `entityTags` | `qloo_find_tags` → `/v2/tags`; `qloo_entity_tags` → `/v2/insights` (urn:tag) | ✅ **CONFIRMED** (LC-2, LC-4); noisy tag types need filtering |
| Cross-domain insights | `recommend` | `qloo_recommend` → `/v2/insights` with entity and tag signals, cross-type targets, `affinity`, `explainability` | ✅ **CONFIRMED** (LC-5a, 5b, 16); single-seed face validity is limited |
| Recommendations | `recommend`, `rank` | `qloo_rank` → `/v2/insights` (`filter.results.entities`) | ✅ **CONFIRMED** (LC-6) |
| Audience comparison | `compareAudiences` | `qloo_compare_audiences` → `/v2/analysis/compare` | 🟨 **PARTIAL**: tag profiles + overlap lists, no score; `limit` not honored (LC-7) |
| Location insights | `wherePopular` | `qloo_where_popular` → `/v2/insights` (`filter.location.query`) | 🟨 **PARTIAL**: intra-city geohash cells, no names (LC-8) |
| Audience demographics | `audienceDemographics` | `qloo_audience_demographics` → `/v2/insights` | ✅ **CONFIRMED** (aggregate relative indices; LC-10) |
| Trends | `trends` | `qloo_trends` → `/v2/trending` | 🟨 **PARTIAL**: `movie` ok; `book` → `QLOO_CONTRACT`; recent `artist` window → 0 points (LC-9…9d) |
| Rate-limit code / quota / expiry | — | — | ⛔ **UNKNOWN** |

### 5.5 V1 observed contract (2026-10-21)

Full evidence: [research/QLOO_V1_VALIDATION.md](research/QLOO_V1_VALIDATION.md). No raw responses are committed (R-08).

#### 5.5.1 Transport and endpoint

- **Workflows:** `qloo mcp` (10 tools) and `qloo exec` (the same 9 workflows), with identical envelopes (LC-12). **Search** uses `qloo api search` only.
- **Endpoint:** both `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` must be set to `https://hackathon.api.qloo.com` in the process that runs `qloo`. Without trust, the harness refuses a custom base URL; without the base URL, it uses `https://api.qloo.com`.
- **Latency:** 2.2–12.5 s per call (median ≈ 3.2 s). The 30 s per-call timeout stays.
- **Exit codes:** 0 on success and on `needs_input`. On failure: 1 (`QLOO_CONTRACT`), 4 (`QLOO_AUTH`).

#### 5.5.2 Errors

| Code | Meaning (observed) | Retryable | Adapter mapping |
|---|---|---|---|
| `QLOO_AUTH` | Missing or rejected credential | false | `ERROR` → run `FAILED (QLOO_UNAVAILABLE)` |
| `QLOO_CONTRACT` | The request violates the upstream contract (e.g. trends with `book`) | false | `ERROR` → claim `UNTESTABLE` for that combination; record the combination in the capability matrix |
| rate limit | Not observed. The harness lists `rate_limit` as a safe retry class; the code string is unknown | true (per capabilities) | Retry policy (AGENT_WORKFLOW §10) |

#### 5.5.3 Inputs and outputs per method

| `QlooPort` method | Harness call and key inputs | Output used by Tessaloom (observed) |
|---|---|---|
| `searchEntities` | `qloo api search --query --type <alias\|urn> --take --json` | Array of `{ name, entity_id, types[], popularity, disambiguation, properties, tags[{ name, tag_id, type, value }] }` |
| `describeEntity` | `qloo_describe { entity, type? }` | `results[{ entity_id, name, popularity, properties }]`; `resolution.outcomes[{ status, match, selected, alternatives[] }]` or `resolution.issues[{ kind: "ambiguous", candidates[] }]` |
| `findTags` | `qloo_find_tags { query, semantic?, limit≤20 }` | `results[{ id (tag URN), name, type, popularity }]` |
| `entityTags` | `qloo_entity_tags { entities[≤10], entity_type?, limit≤20 }` | `results[{ id, name, type, popularity, affinity }]` |
| `recommend` | `qloo_recommend { target_type, signals[≤10]?, signal_tags[≤10]?, signal_tags_operator?, signal_location?, demographic?, filter_location?, include_tags?, exclude_tags?, explain?, limit≤20 }` | `results[{ entity_id, name, subtype (category URN), popularity, affinity, explainability, properties }]`; top-level `explainability` |
| `rank` | `qloo_rank { options[≤10], option_type, signals?, … }` | Same item shape, ordered by affinity. Scores are not comparable across calls. |
| `compareAudiences` | `qloo_compare_audiences { group_a[≤10], group_b[≤10], target_type? }` | `results{ tags[], a[], b[], matchEntities[] }`; items `{ tag_id, name, subtype, entity_id, popularity, query.count }` |
| `wherePopular` | `qloo_where_popular { entity, entity_type?, within, limit≤20 }` | `results[{ location{ latitude, longitude, geohash }, query{ affinity, affinity_rank, popularity } }]` |
| `audienceDemographics` | `qloo_audience_demographics { entity, entity_type? }` | `results[{ query{ age{6 bands}, gender{ male, female } } }]` as relative indices in [−1, 1] |
| `trends` | `qloo_trends { entities[1..5], entity_type, start_date, end_date, limit≤20 }` | `series[{ entity, points[{ date, population_percentile, population_rank (string), population_rank_velocity, velocity_fold_change, population_percent_delta }] }]` |

**Type tokens.** Inputs use short names (`artist, book, brand, movie, person, place, podcast, tv_show, videogame`, plus `locality, actor, album, author, director` for name-resolving tools). Outputs use URNs (`urn:entity:videogame`, `urn:entity:author`, …). A legacy `urn:entity:author` ID worked as a `recommend` signal (LC-16).

#### 5.5.4 Consequences for `QlooPort` and evaluators

- **Disambiguation (gate H2).** Never auto-accept on `match: "exact"`. Show the selected entity plus its alternatives with type, popularity, and description. For localities, enrich candidates via `searchEntities(type=locality)` to obtain `disambiguation`. Persist `resolution` (outcomes/issues, alternatives, strategy, provenance) in `entity_resolution_records.candidates`.
- **Tags.** Every concept goes through tag confirmation (one concept → several tag types). `TAG_RESONANCE` uses an allowlist of tag types **observed in V1**: `genre`, `subgenre`, `keyword`, `plot`, `motif`, `character`, `style`. It excludes `endorsement` and `book_format`. Other observed types (`interests`, `audience`, `instrument`, `music`, `artist`) are not used for resonance until reviewed. The list is versioned with the ruleset.
- **`CROSS_DOMAIN_AFFINITY`.** Read the category from `subtype`. Prefer ≥ 2 signals or a tag signal. Stances use affinity *relative to the result set* (rank and spread), not presence alone. Thresholds are versioned in the ruleset.
- **`AUDIENCE_BRIDGE`.** Redefined: SUPPORTS when `tags[]` or `matchEntities[]` is non-empty, or when `a` and `b` share tag subtypes beyond a threshold. INSUFFICIENT when all overlap lists are empty (absence of overlap in the top lists is not proof of disjoint audiences).
- **`LOCATION_FIT`.** Redefined: "within the venue's locality, how strongly does the anchor entity's audience concentrate?" Use top-cell affinity and `affinity_rank`, and proximity of the venue to high-affinity cells if coordinates are known. It does not test popularity *in* a city versus elsewhere.
- **`MOMENTUM`.** Allowed only for type and window combinations that return points (observed: `movie`). `book` → UNTESTABLE. Empty `points` → INSUFFICIENT.
- **`AUDIENCE_PROFILE`.** Values are relative indices; the UI must not present them as shares of people.

---

## 6. Qloo adapter design (`packages/qloo-adapter`)

### 6.1 Port

```ts
export interface QlooPort {
  capabilities(): Promise<QlooReadiness>;
  searchEntities(i: SearchEntitiesInput, ctx: CallContext): Promise<QlooOutcome<NormalizedEntity>>;
  describeEntity(i: DescribeEntityInput, ctx: CallContext): Promise<QlooOutcome<NormalizedEntity>>;
  findTags(i: FindTagsInput, ctx: CallContext): Promise<QlooOutcome<NormalizedTag>>;
  entityTags(i: EntityTagsInput, ctx: CallContext): Promise<QlooOutcome<NormalizedTag>>;
  recommend(i: RecommendInput, ctx: CallContext): Promise<QlooOutcome<RankedEntity>>;
  rank(i: RankInput, ctx: CallContext): Promise<QlooOutcome<RankedEntity>>;
  compareAudiences(i: CompareInput, ctx: CallContext): Promise<QlooOutcome<ComparisonItem>>;
  audienceDemographics(i: DemographicsInput, ctx: CallContext): Promise<QlooOutcome<DemographicFact>>;
  wherePopular(i: WherePopularInput, ctx: CallContext): Promise<QlooOutcome<GeoPopularity>>;
  trends(i: TrendsInput, ctx: CallContext): Promise<QlooOutcome<TrendPoint>>;
}

type CallContext = { runId?: UUID; stepSeq?: number; signal: AbortSignal; budget: BudgetGuard; purpose: string };

type QlooOutcome<T> =
  | { kind: "OK"; items: T[]; quality: "FULL" | "PARTIAL" | "DEGRADED"; summary: string; provenance: QlooProvenance }
  | { kind: "EMPTY"; summary: string; provenance: QlooProvenance }
  | { kind: "NEEDS_INPUT"; summary: string; candidates: NormalizedEntity[]; provenance: QlooProvenance }
  | { kind: "ERROR"; code: string; retryable: boolean; recovery?: string; provenance: QlooProvenance };

type QlooProvenance = {
  toolInvocationId: UUID;       // row in tool_invocations
  snapshotId: UUID | null;      // row in qloo_response_snapshots (raw envelope)
  transport: "HARNESS_MCP" | "HARNESS_CLI" | "FIXTURE";
  workflow: string;             // e.g. "qloo_recommend"
  harnessVersion: string;
  requestHash: string;          // sha256(JCS({workflow, args}))
  dataOrigin: "LIVE" | "CACHE" | "REPLAY" | "FIXTURE";
  retrievedAt: string;          // when the underlying data was fetched live
};
```

### 6.2 Normalization

- Normalizers (`normalize/*.ts`) map raw `results[]` items to `NormalizedEntity { qlooId, name, type, tags?: NormalizedTag[], popularity?: number, affinity?: number, properties?: Record<string, unknown> }`.
- **Optional fields stay `undefined` unless they are actually present.** No defaults are invented. Normalizers record `missingFields[]` so the UI and evaluators know what was absent.
- Every normalizer is driven by **recorded live envelopes** (contract fixtures) once the key arrives. Until then, normalizers parse only `status`, `summary`, `result_count`, and `error`, and treat items as opaque `unknown` validated by permissive schemas. Evaluators that depend on specific fields return INSUFFICIENT with `reason: "FIELD_UNAVAILABLE"`.
- **V1 status:** no normalizer code existed yet (`packages/qloo-adapter` is an M0 stub), so there was no code to update. The mapping below is the **observed specification** that M2 implements. All fields remain optional in the schemas, and unknown extra fields are preserved in `properties`.

| Normalized field | `searchEntities` | `describeEntity` | `recommend` / `rank` | `findTags` | `entityTags` |
|---|---|---|---|---|---|
| `qlooId` | `entity_id` | `entity_id` | `entity_id` | `id` | `id` |
| `name` | `name` | `name` | `name` | `name` | `name` |
| `type` (URN) | `types[0]` (all kept in `types`) | `resolution…selected.type` | **`subtype`** (`type` is the generic `urn:entity`) | `type` (tag type URN) | `type` |
| `popularity` | `popularity` | `popularity` | `popularity` | `popularity` | `popularity` |
| `affinity` | — | — | `affinity` | — | `affinity` |
| `disambiguation` | `disambiguation` | `alternatives[].description` / `candidates[].description` | — | — | — |
| `tags` | `tags[{ tag_id, name, type }]` | — | — | — | — |
| `explainability` | — | — | `explainability["signal.interests.entities"][]` | — | — |
| `properties` | `properties` | `properties` | `properties` | — | — |

- Special shapes:
  - `compareAudiences` → `ComparisonItem { side: "a"|"b"|"shared", tagId, name, subtype, entityId, popularity, count }`, plus `matchEntities` kept as is.
  - `wherePopular` → `GeoPopularity { latitude, longitude, geohash, affinity, affinityRank, popularity }`.
  - `audienceDemographics` → `DemographicFact { dimension: "age"|"gender", band, index }`.
  - `trends` → `TrendPoint { entityId, date, populationPercentile, populationRank (string→number with the original kept), rankVelocity, velocityFoldChange, percentDelta }`.
- **Provenance from the harness.** Copy `execution.correlation_id`, `execution.transport`, `execution.duration_ms`, `provenance.endpoint`, `provenance.requests`, `interpretation`, `query_intent`, and `resolution` into the `tool_invocations` record and the evidence trace. This replaces the planned reconstruction of the request from arguments.

### 6.3 Transports

| Transport | Implementation | When used |
|---|---|---|
| `HarnessMcpTransport` | `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport({ command: "qloo", args: ["mcp"], env: process.env })`. On connect: `listTools()` (tool schemas are cached and logged at startup for contract discovery) and `callTool({ name: "qloo_capabilities" })`. Calls use `callTool({ name, arguments })` and read `structuredContent`. The worker env must include `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` (V1). Verify at boot that `qloo doctor --json`'s `qloo-endpoint-trust` reports the hackathon endpoint. | Default in staging/production |
| `HarnessCliTransport` | `execFile("qloo", ["exec", workflow, "--input-file", tmpJson])` or `execFile("qloo", ["api", command, ...flags, "--json"])` with a timeout. Never uses a shell and never passes `--api-key`. Arguments are validated against an allowlist before spawning. Parse stdout as JSON in both cases: a result envelope or a bare `{ error, operation, correlation_id }` object (exit 1/4). Do **not** use `--dry-run` to verify endpoints (it ignores `QLOO_BASE_URL`). | **Always** for `searchEntities` (no search workflow exists) and locality disambiguation; fallback for workflows while the MCP child is unhealthy |
| `FixtureTransport` | Reads `fixtures/qloo/<workflow>/<requestHash>.json`. Unknown hash → `ERROR { code: "FIXTURE_MISSING" }`. **Never** falls back to "closest" data. | `QLOO_MODE=fixture` in local development, CI, and E2E. **Refuses to construct when `APP_ENV=production`.** |

### 6.4 Fixture policy: no silent substitution

1. **Labeling.** Each fixture file has a top-level `"_fixture": { "synthetic": true, "label": "DEVELOPMENT FIXTURE — NOT QLOO DATA", "author": "...", "createdAt": "..." }`. Fixture entity IDs use the prefix `fixture-` and names end in "(fixture)".
2. **Provenance.** Fixture-derived records get `dataOrigin: FIXTURE` and `provenance_class: DEVELOPMENT_FIXTURE`.
3. **UI.** A persistent, non-dismissible banner reads *"Development fixtures — not real Qloo data"*. Every fixture-derived node or card carries a FIXTURE badge.
4. **Production guard.** Production builds with `QLOO_MODE=fixture` fail at boot. The API refuses to serialize `DEVELOPMENT_FIXTURE` records in production (defense in depth).
5. **No fallback.** When a live call fails, the adapter returns `ERROR`. There is **no code path** from `HarnessMcpTransport` or `HarnessCliTransport` to `FixtureTransport`. A unit test asserts this, and an ESLint import rule forbids live transports from importing the fixture module.
6. **Recorded live data is different from fixtures.** Snapshots recorded from live calls (for sample projects) remain `QLOO_SOURCED` with `dataOrigin: REPLAY` and the original `retrievedAt`. The UI shows *"Qloo data recorded on 2026-10-2X"*. Whether storing these is allowed is pending Qloo terms review (R-08).

### 6.5 Caching

- **Key.** `requestHash = sha256(JCS({ workflow, args, harnessVersion }))`.
- **Store.** `qloo_response_snapshots` (raw envelope, `retrieved_at`, `expires_at`).
- **TTL by workflow.** Search, describe, and tags: 7 days. Recommend, rank, compare, demographics, where-popular, trends: 24 hours.
- **Dedup.** Concurrent identical requests within a run are coalesced in memory.
- **Reuse.** A cache hit creates a new `tool_invocations` row with `data_origin = CACHE` and `cache_source_invocation_id` pointing at the original, so every evidence record still has its own trace.
- **Cache-control flags.** `ctx.cachePolicy ∈ { "prefer-cache", "live-only", "replay-only" }`. REVALIDATION runs use `live-only`; sample projects use `replay-only`.

### 6.6 Rate limiting and quota

- **Token bucket** in the worker, with capacity and refill from `QLOO_RATE_LIMIT_PER_MIN` (default **20/min, conservative, to be replaced by the published limit**). Concurrency is 2.
- **Daily guard.** `usage_counters (scope='global', metric='qloo_calls', day)` is incremented in its own transaction **before** each call. The call is refused if it would exceed `GLOBAL_DAILY_QLOO_CALLS`.
- **Retries.** Retries consume tokens and quota. There are never unbounded retries.

---

### 6.7 M2 implementation status (2026-10-21)

`packages/qloo-adapter` implements this section:

| Part | Implementation |
|---|---|
| Inputs | Zod schemas with V1 bounds (`inputs.ts`), mapped to the exact snake_case harness arguments. Undefined options are dropped before hashing. |
| Transports | `McpTransport` (persistent `qloo mcp`, bounded restarts), `CliTransport` (`qloo exec <workflow> --input <json>`, `qloo api search … --json`, no shell, never `--api-key`, stdout parsed on non-zero exits), `LiveHarnessRouter` (MCP → CLI fallback; search always CLI), `FixtureTransport` (dev/test only). |
| Envelopes | `parseEnvelope` classifies `search_array`, `result_list`, `compare_object`, `series`, `needs_input`, `error_object`, and `unknown` (→ `UNKNOWN_ENVELOPE`). It extracts the correlation ID, endpoint, request records, and every resolution candidate (selected, alternatives, issue candidates, with provenance). |
| Normalizers | `normalize.ts` per §6.2: the category comes from `subtype`; comparison results carry no score; trend ranks keep the original string. |
| Outcomes | `OK` / `EMPTY` / `NEEDS_INPUT` / `UNSUPPORTED` (local, V1-known) / `ERROR`. The raw payload is held in memory for evidence extraction and pointer verification (`verifyPointer`), then discarded. |
| Recording | `createDbRecorder`: one `tool_invocations` row per call (cache hits included) and a structural snapshot without the raw payload unless `QLOO_RAW_RETENTION=on`. `createDbQuotaGuard`: atomic daily reservation. |
| Readiness | `checkQlooReadiness`: `qloo --version` + `qloo doctor --json` (no network); ready only with a configured credential **and** the trusted hackathon endpoint. |
| Live verification | A 3-call smoke through the real adapter on 2026-10-21: search (CLI) OK; "Lisbon"/locality → `NEEDS_INPUT` with 4 candidates (no disambiguation text); recommend (MCP) OK with `subtype` category, affinity, and harness provenance; trends/book → local `UNSUPPORTED`. |

### 6.8 M4 run API status (2026-10-21)

Implemented: `GET /api/v1/workspace`, `POST /api/v1/projects/:projectId/experiments`, `GET /api/v1/runs/:runId`, `GET /api/v1/runs/:runId/events`, and `POST /api/v1/runs/:runId/{confirmations,cancel,retry}`, plus heartbeat-aware `/api/health/ready` (ADR-023).

- **Workspace and CSRF.** `GET /api/v1/workspace` issues the `tl_ws` cookie (HttpOnly) and the `tl_csrf` double-submit cookie. Every mutation requires `X-Tessaloom-CSRF` and a matching `Origin`/`Host`.
- **Starting a run.** The experiment `mode` and the `RunConfig` come from the worker's latest heartbeat, never from the client (`mode: "live"` in the body is accepted as specified). Without a heartbeat younger than 30 s, the start returns `503 WORKER_OFFLINE`.
- **Retry.** `POST /retry` returns `409` unless the run `FAILED` transiently.
- **SSE.** The stream polls every 1 s and resumes from `Last-Event-ID` or `?after=`. It sends a `: ping` every 15 s and closes with `event: run-terminal` (`{ state, lastSeq }`) on a paused or terminal state.
- **Queue topology (§8).** `run.step` uses policy `exclusive`. The migrator creates the `pgboss` schema and queues. `maintenance.recover-runs` (every 5 min) is added.
- **Not yet implemented.** The project, brief, and other endpoints in §4.1–§4.7 arrive with their milestones (M5+).

### 6.9 M5 API status (2026-10-21)

Added:
- `POST/GET /api/v1/projects`, `GET /api/v1/projects/:projectId` (overview with brief versions and experiments);
- `POST /api/v1/projects/:projectId/briefs`, `GET /api/v1/briefs/:briefVersionId`;
- `GET /api/v1/experiments/:experimentId` (read model: brief, runs, LLM providers used, resolutions, seeds, entities with data origin, relations, pool, hypotheses with claims and evidence);
- `GET /api/v1/evidence/:evidenceId/trace` and `GET /api/v1/invocations/:invocationId` (redacted request, envelope, pointer facts);
- `GET /api/v1/system/status` (worker online, mode, Qloo readiness).

Every read is workspace-scoped, and a production build refuses to serialize `DEVELOPMENT_FIXTURE` records (AGENT_WORKFLOW §13.1). The BRIEF confirmation accepts `interestDomains` edits, and an ENTITIES `candidate` choice may name a tag ID.

### 6.10 M6 API status (2026-10-21)

- **Gate H2b.** A run pauses at `AWAITING_POOL_CONFIRMATION` with `pendingConfirmation = { kind: "POOL", tension }`. `POST /runs/:runId/confirmations` with `{ kind: "POOL", tension }` re-selects the stored pool with core `selectPool`, updates `collision_candidates.selected/rank/tension_fit`, and continues the run. It returns `422` when the tension leaves fewer than 3 candidates.
- **Hypothesis selection.** `{ kind: "HYPOTHESIS_SELECTION", selectedHypothesisIds }` (0–3, active hypotheses only) sets `user_pinned` and completes the EXPLORATION run.
- **Experiment read model.** Evidence now carries `rationale` (the evaluator's plain-language rule). `scoreBreakdown` carries `feasibility { version, rules[] }`, `noveltyInputs`, and the critic's `critique`, labeled as interpretation.

### 6.11 M7 API status (2026-10-22)

- `GET /api/v1/experiments/:experimentId/graph?include=threads,retired` returns `EvidenceGraph { version, nodes[], edges[], layout }` from `core/graph.ts`. Nodes are `entity | hypothesis | claim | evidence`. Edges are `THREAD | ELEMENT_OF | HAS_CLAIM | TESTED_BY | CITES | REVISION_OF`. Each node and edge carries a provenance class, and data-backed nodes carry the `invocationId` for Trace. Fixture records are refused in production, as for every read.
- `PUT /api/v1/experiments/:experimentId/graph-layout` takes `{ positions: { nodeId, x, y }[] }` (at most 2000) and returns `204`. It is CSRF-checked, rate-limited, and workspace-scoped (404 otherwise).

### 6.12 M8 API status (2026-10-22)

- `POST /api/v1/experiments/:id/branches/preview` `{ delta, mode? }` returns the dependency plan: `{ dirtyQueries, reusedQueries, estimatedQlooCalls, rescoreOnly, needsConfirmation, dirtyList[], claims{reuse,inherit,dirty,unsupported}, unsupported[], mode, qlooCallsToday }`. It has no side effects (CSRF-checked and rate-limited, like every POST).
- `POST /api/v1/experiments/:id/branches` `{ delta, mode: "hold_hypotheses", label? }` returns `202 { branchExperimentId, experimentKey, runId, plannedDirtyQueries, reusedQueries, reused }`. An identical delta returns the existing branch (`reused: true`, WI-A5). A delta the harness cannot apply returns `422` with the reason. The parent's hypotheses must be final (its run finished or awaits H3).
- `GET /api/v1/experiments/:id/branches` returns the whole tree (root and branches), each with its delta, planned counts, latest run, and comparison id.
- `POST /api/v1/comparisons` `{ baseExperimentId, otherExperimentId }` (same project) returns `201`. Metrics are computed synchronously, with a deterministic narrative labeled APP_DERIVED. `GET /api/v1/comparisons/:id` returns the stored comparison, including the R5 narrative for branch comparisons, labeled MODEL_INTERPRETATION.
- Gate H4: `{ kind: "COUNTERFACTUAL_COST", action: "run" | "cancel", maxQlooCalls? }`. `maxQlooCalls` may only lower the run's cap.

### 6.13 M9 API status (2026-10-22)

**Blueprints**

- `POST /api/v1/experiments/:experimentId/blueprints` `{ hypothesisIds (1–3), format: "event" | "series" | "installation" }` returns `202 { blueprintId, runId }`.
  - It starts a COMPOSITION run.
  - It returns `409 STATE_CONFLICT` while any run on the experiment is non-terminal (at gate H3, record the selection first).
  - It returns `400 VALIDATION_FAILED` when the source run is not COMPLETED / COMPLETED_WITH_LIMITS.
  - Hypotheses must belong to the experiment.
- `GET /api/v1/projects/:projectId/blueprints` returns `{ items: [{ id, experimentId, format, status, title, revisionNumber, updatedAt }] }`.
- `GET /api/v1/blueprints/:id` returns `{ blueprint, experiment, hypotheses, current, appendix, revisions, latestRun }`.
  - `current` holds the content and its `traceabilityReport`.
  - `appendix` entries carry `E-n` labels, claim, stance, rationale, provenance, data origin, and retrieval date.
- `GET /api/v1/blueprints/:id/revisions` lists the revisions. `GET .../revisions/:revisionId` returns one revision with its appendix.
- `POST /api/v1/blueprints/:id/revisions` `{ baseRevisionId, content, restoreOfRevisionNumber? }` returns `201`.
  - A stale base returns `409`.
  - Unchanged content, unresolvable citations, or changed constraints return `400 VALIDATION_FAILED`.
  - The server re-derives provenance (ADR-028 §3).
  - With `restoreOfRevisionNumber`, the server copies that stored revision and ignores the client's `content`. Restoring the current content returns `400`.
- `POST /api/v1/blueprints/:id/status` `{ status: "DRAFT" | "ACCEPTED" }`.
- `POST /api/v1/blueprints/:id/sections/:sectionKind/recompose` `{ instruction? (≤ 300) }` returns `202 { runId }`: a COMPOSITION run limited to one section.
- `GET /api/v1/blueprints/:id/export?format=md|json` returns `200` with `Content-Disposition: attachment; filename="<slug>-r<n>.md|json"`.

**Share links**

- `POST /api/v1/projects/:projectId/share-links` `{ scope: "project" | "experiment" | "blueprint", targetId, expiresInDays? (1–90, default 30) }` returns `201 { shareLinkId, url: "/share/<token>", expiresAt }`. The token is never returned again. A target outside the project returns `404`.
- `GET /api/v1/projects/:projectId/share-links` returns metadata only: id, scope, targetId, createdAt, expiresAt, revokedAt, viewCount.
- `DELETE /api/v1/share-links/:id` returns `204`. Revocation is immediate.
- `GET /api/v1/share/:token` (no session needed) returns the scoped read-only payload. `GET /api/v1/share/:token/export` returns the Markdown export (blueprint scope only).
  - Headers: `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`.
  - Limited to 30 lookups/min per IP hash (`429`).
  - An unknown, revoked, or expired token returns a uniform `404` "This link is no longer active.".
- Every mutation is CSRF-checked, rate-limited, and workspace-scoped (`404` otherwise). Fixture records are refused in production, as for every read.

## 7. LLM gateway contract (`packages/llm-gateway`)

```ts
export interface LlmPort {
  generateStructured<T>(req: {
    role: "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
    promptId: string;            // e.g. "hypothesis.generate"
    promptVersion: string;       // semver, from the prompt registry
    input: unknown;              // serialized as delimited JSON data blocks
    schema: z.ZodType<T>;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    maxOutputTokens: number;
    ctx: CallContext;
  }): Promise<
    | { ok: true; value: T; invocationId: UUID; usage: TokenUsage; modelId: string }
    | { ok: false; reason: "REFUSED" | "TRUNCATED" | "INVALID_OUTPUT" | "UNAVAILABLE" | "BUDGET"; invocationId: UUID }
  >;
}
```

Default provider behavior (Anthropic Claude API, `@anthropic-ai/sdk`):

- **Models (ADR-018).** Primary `env.LLM_MODEL` (default `claude-opus-5-5`); fallback `env.LLM_FALLBACK_MODEL` (default `claude-sonnet-5-5`). Both IDs were verified against the official models overview on 2026-10-20. Account access is verified in M3. The fallback applies to a **whole step** (never mid-conversation, since thinking blocks are model-bound) when the primary is unavailable after retries, when the remaining cost budget only covers the fallback, or when `LLM_MODE=economy`. The result reports the `modelId` actually used, and `llm_invocations.fallback_used` is set.
- **Request.** `model` = the selected model. `thinking: { type: "adaptive" }` with display omitted. `output_config: { effort, format: <JSON Schema from Zod> }`. Parsed with the SDK's `messages.parse` helper.
- **Streaming.** Used when `maxOutputTokens > 16000`, with `finalMessage()` to collect the result.
- **Not used.** `temperature`, assistant prefill, and forced `tool_choice` are not supported on this model family.
- **Refusal fallback.** `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta. `stop_reason` is checked (`refusal`, `max_tokens`) before parsing.
- **Prompt caching.** A `cache_control` breakpoint after the stable system prompt and role instructions. `usage.cache_read_input_tokens` is monitored.
- **Recording.** Every call writes an `llm_invocations` row: model, prompt ID and version, input hash, output JSON, usage, validation status, latency, and stop reason. Raw thinking content is not stored.
- **Swapping providers.** Another provider can be added by implementing `LlmPort`. It must support JSON-Schema-constrained output. The choice is recorded in `configSnapshot` and therefore in the experiment key.

---

## 8. Worker job contracts (pg-boss)

| Queue | Payload | Singleton key | Retry |
|---|---|---|---|
| `run.step` | `{ runId: UUID, expectedStateVersion: number }` | `run:${runId}:${expectedStateVersion}` | 2 retries, 15 s backoff; visibility timeout 10 min |
| `resolve.entity` | `{ resolutionId: UUID }` | `resolve:${resolutionId}` | 1 retry |
| `comparison.narrate` | `{ comparisonId: UUID }` | `cmp:${comparisonId}` | 1 retry |
| `maintenance.expire-paused-runs` | `{}` | cron, every 15 min | — |
| `maintenance.retention` | `{}` | cron, daily 04:00 UTC | — |
| `maintenance.worker-heartbeat` | — | in-process timer, not a job | — |

---

## 9. Read-model types (selection)

```ts
type ProvenanceClass =
  | "QLOO_SOURCED" | "APP_DERIVED" | "MODEL_INTERPRETATION"
  | "CREATIVE_SPECULATION" | "USER_PROVIDED" | "DEVELOPMENT_FIXTURE";

type GraphNode = {
  id: string;
  kind: "entity" | "tag" | "hypothesis" | "claim" | "evidence" | "experiment" | "blueprint";
  label: string;
  provenance: ProvenanceClass;
  status?: HypothesisStatus | EvidenceStance;
  domain?: Domain;
  dataOrigin?: "LIVE" | "CACHE" | "REPLAY" | "FIXTURE";
  refId: UUID;
};
type GraphEdge = {
  id: string; source: string; target: string;
  kind: "THREAD" | "BRIDGE" | "ELEMENT_OF" | "CLAIM_OF" | "SUPPORTS" | "CONTRADICTS"
      | "NEUTRAL" | "BRANCHED_FROM" | "COMPOSED_FROM";
  provenance: ProvenanceClass;
  evidenceIds: UUID[];
};
```

---

## 10. SSE run event contract

`GET /api/v1/runs/:runId/events` responds with `Content-Type: text/event-stream`. A heartbeat comment (`: ping`) is sent every 15 s.

```
id: 42
event: run-event
data: {"seq":42,"ts":"2026-10-25T14:03:11.204Z","type":"TOOL_CALL_FINISHED","state":"COLLECTING_EVIDENCE",
       "role":"R4","summary":"qloo_recommend → 20 books for 2 signals (ok, 1.8 s)",
       "payload":{"toolInvocationId":"01J…","workflow":"qloo_recommend","status":"ok",
                  "resultCount":20,"latencyMs":1812,"dataOrigin":"LIVE"}}
```

- `payload` schemas are defined per `type` in `packages/core/src/agent/events.ts`.
- Payloads **never** include credentials, raw prompts, or raw Qloo responses. Raw data is reachable only through the evidence trace endpoint, scoped to the workspace or share token.
- The stream closes with `event: run-terminal` once the run reaches a terminal or paused state. The client reconnects only when a new job is enqueued.
