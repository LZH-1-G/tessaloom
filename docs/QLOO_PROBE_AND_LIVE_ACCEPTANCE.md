# Qloo startup probe and live Agent acceptance — 2026-10-26

## Current conclusion

Production is **recovered according to the owner's same-instance evidence**. The initial
failure at 2026-10-25 14:09:30 UTC (22:09:30 Beijing) was followed by successful probes at
14:14, 14:19, 14:24, 14:29 and 14:34 UTC. Each success reports ready=true,
endpointTrusted=true and Harness 0.1.26. The owner also confirmed healthy database/queues,
HTTP readiness 200, a successful Qloo HTTP request and a real CLI search as tl-worker.
Those original API/CLI observations were supplied by the owner. A subsequent read-only
Northflank CLI inspection independently verified the current service, configuration and logs
as described below; no live provider request was executed here.

This pattern establishes a transient startup probe failure followed by recovery, not a
persistent missing Harness, broken endpoint trust or credential failure. CPU contention is
a reproduced local explanation, **not the proven cause of the historical production event**:
the old event did not retain timeout/exit diagnostics. A successful search also does not
prove MCP workflow calls, LLM generation, evidence persistence or blueprint completion.

Local base is e609a87e3419febbd342fe3bcce36a7a881fda39 on
codex/northflank-production-repair. Production commit 263c7c391265658f643df176a3959b9029c4118e
is present locally and has the same source tree. Existing changes were preserved.
The optional patch remains uncommitted and unpublished. Only read-only Northflank management
API requests were made. No production exec/SQL, configuration change, live provider call,
commit, push, merge or deployment was performed in this stage.

## Exact path and reproduction

`apps/worker/src/main.ts` calls refreshReadiness at startup and every five minutes.
It calls `checkQlooReadiness` in `packages/qloo-adapter/src/readiness.ts`, using the
Qloo-only environment from `transports/env.ts`. `scripts/start.mjs` supplies the controlled
PATH and worker UID/GID; model keys and database credentials are excluded from Qloo children.
The resulting state is logged as worker_qloo_readiness and copied to subsequent heartbeats.
Infrastructure `/api/health/ready` checks DB plus fresh worker heartbeat, independently of
the Qloo readiness field exposed by `/api/v1/system/status`. This behavior is unchanged.

The old probe started `qloo --version`, then `qloo doctor --json`, each with a 15-second
timeout. All failures collapsed into harness_unavailable and cleared the version/trust
fields. Those false/null values mean the observation failed, not an independent negative
trust verdict. The pinned CLI router eagerly imports its command graph even for --version;
doctor already returns `versions.harness`. Doctor without --network makes no Qloo call.
Exit 1 can legitimately mean a missing model credential, intentionally absent from this child.

Offline tests used the existing Node 22 image, Harness 0.1.26, UID/GID 10002, 512 MiB,
0.2 CPU, a fake Qloo key, matching endpoint/trust variables and `--network none`:

| Observation | Result |
| --- | --- |
| Old probe without a CPU competitor | ready=true; two commands totaled 15,703 ms |
| Standalone --version / doctor | 9,203 / 7,097 ms; doctor exit 1, valid auth/trust checks, model-auth warning |
| Old probe with one bounded 20-second CPU competitor | Same production-shaped false/null event at 15,111 ms |
| New probe under the same contention scenario | ready=true, version 0.1.26, 16,099 ms |

Timings are observations, not guaranteed managed-platform latency. No production environment
values or credentials were copied into the reproduction.

## Minimal optional changes

| File | Change |
| --- | --- |
| `packages/qloo-adapter/src/readiness.ts` | One offline doctor call; version from validated report; bounded 30-second timeout and 128 KiB output; timeout kills the probe; accept normal exit or warning exit 1 only; exact normalized endpoint comparison; safe failure classes and duration |
| `apps/worker/src/main.ts` | Add probeDurationMs and fixed probeFailure to the existing event |
| `tests/unit/qloo-adapter.test.ts` | Existing doctor stub includes the actual CLI's version field |
| `tests/unit/qloo-readiness.test.ts` | 12 real-subprocess regressions: one invocation, warning exit, timeout despite valid output, bad exit, malformed/version output, missing/execution-denied binary, output limit, trust prefix rejection, secret exclusion and recovery |
| `deploy/northflank-smoke.mjs` | Fake key on private test network; assert the actual supervised Worker's local probe at 0.2 CPU; parse redacted supervisor child_log envelopes |
| `docs/QLOO_PROBE_AND_LIVE_ACCEPTANCE.md` | This evidence and acceptance plan |

No database privilege, schema, secret, dependency, application workflow, provider routing,
five-minute refresh interval or infrastructure readiness change. The probe is configuration
readiness, not live authentication/capability validation. No fixture fallback was added.
Killed/truncated/unexpected-exit output never becomes ready; raw stdout/stderr/error text,
paths and environment values are not returned or logged. Endpoint lookalikes are rejected.

Validation: 435 unit tests passed (29 files); ESLint, Prettier and root/scripts/worker/web
type checks passed. The production image exists as `tessaloom:qloo-readiness`, Linux ARM64,
Node 22.23.4, ID `sha256:f1eff64b9c47eadc96394f5223f0ccbfa318ec12e1745ce706de50e011ac7795`.
Its Worker bundle SHA-256 equals the local build:
`c54d35444420957e614bdd1c12811c8a3f4ebd31830a5cec78fe07f038c143f1`.
Final validation also passed: all 16 subprocess tests; the complete Northflank-equivalent
container smoke (0.2 CPU / 512 MiB, actual supervised Worker probe ready in 14,008 ms,
224.1 MiB observed peak memory, zero live/paid calls, exit 0); and a fully offline redacted
Gitleaks scan of all six changed/new files (no findings). The smoke verified TLS/read-only DB
diagnostics, missing-schema failure, revoked queue privileges returning 503, recovery,
instance-scoped heartbeat freshness, database restart and clean shutdown. The subprocess
suite first encountered local listen EPERM under execution restrictions; rerunning with
local-port permission passed without code changes. No database implementation changed,
so the historical 88-test integration suite was not rerun for this optional patch.
The first new container assertion incorrectly looked for a top-level Worker event;
the supervisor actually wraps it in child_log.message. Only the test parser was corrected.
Remote CI/AMD64 were not rerun for this uncommitted optional patch.

## Independently inspected production state

Read-only Northflank CLI requests identified project `default`, service `tessaloom`, current
instance `tessaloom-7fbc66797b-qkgm9`, deployment `6ade0d788cc013adf8a7b4de`,
build `tidy-belief-7454`; its build API reports SUCCESS and exact commit
`263c7c391265658f643df176a3959b9029c4118e`. Platform health observed at **2026-10-26 00:30:17 UTC
(08:30:17 Beijing)** reports TASK_RUNNING, restartCount=0 and a successful readiness probe.
No production shell command or database query was executed.

- Latest eight logged Harness probes, 2026-10-25 23:54 through 2026-10-26 00:29 UTC,
  all report ready=true, endpointTrusted=true, reason=null, harnessVersion=0.1.26 on that
  same instance. This independently confirms continuing recovery, beyond the original five.
- Its queue-start event at **2026-10-25 14:09:16.846 UTC** explicitly reports
  `llm: "unconfigured"`. Queue startup and Harness readiness therefore do not prove Agent
  model availability.
- Both the effective service runtime-environment and inheritance-details APIs show
  QLOO_MODE=live but **no LLM_PROVIDER, LLM_MODE, LLM_MODEL or model API-key entries**.
  Values of credentials were never printed or persisted; only allowlisted nonsecret values
  and configuration structure were inspected. Source defaults are provider=anthropic,
  mode=standard, primary=claude-opus-5-5, fallback=claude-sonnet-5-5. These are configuration
  defaults, not proof of model/account availability or successful requests. The Dockerfile
  adds Qloo endpoint/trust defaults but no model credentials. Missing model configuration
  explains the independently observed unconfigured gateway. No usable configured LLM
  provider currently exists for a real E2E run.
- **Correction to the earlier hypothesis:** DeepSeek appears in the repository's Northflank
  example only; it is not the currently configured production provider. Its synthetic-only
  policy remains relevant if the owner later selects DeepSeek, not as this deployment's
  demonstrated blocker.
- Runtime settings also omit explicit run-access and spend caps. Production source defaults
  are invite access, global LLM $15/day, workspace $3/day, experiment $5 and 300 Qloo
  attempts/day. These are inferred effective defaults from the inspected configuration and
  matching source, not remaining balances. Existing grants/ledger balances were not queried.
  They do not establish the proposed $0.50 acceptance allowance.
- The configured service HTTP port is private (`public: false`). No public judge URL or
  separately configured ingress was established by this inspection. Do not change exposure
  as part of diagnosis.

**Recommended resolution, prepared only:** retain the recovered Qloo deployment and finish
acceptance in an isolated validation deployment/database if production must remain entirely
unchanged. Use the existing supported Anthropic route if an authorized account/key is available;
verify account-supported model IDs and the code's price table before activation. Gemini is
another implemented route, but requires its explicit account/data-sharing approvals. Do not
silently switch providers or claim either account is available. A requirement to use DeepSeek
with real Qloo needs a separately scoped, approved live-data integration with provenance,
sharing and budget controls; changing one flag or deleting the two guards is not a safe fix.

In a later approved activation, set explicit finite caps before installing/activating the
worker-only model credential, keep invite access, and issue one expiring test grant with a
**$0.50 lifetime aggregate ceiling and at most two runs** (exploration plus composition).
Daily caps alone can reset at midnight and are not a session ceiling. Review reservations,
current balances and provider-account controls first; never clear the ledger to obtain budget.
Keep serial execution and use a dedicated new test project only after test-record creation is
authorized. Verify a new `worker_queues_started.llm` event names the intended provider,
then perform one bounded real interpretation before proceeding through the gates below.
If literal zero production writes remains required, only inspect an existing saved real run;
new generation must remain in the separate validation environment. This activation is not
performed or implied by the optional probe change.

## Existing E2E paths and their limits

- `e2e/helpers.ts` and `m5-brief-discovery.spec.ts`: project → brief → H1 interpretation →
  H2 entity choice → Discovery → H2b collision-pool approval.
- `m6-hypothesis-lab.spec.ts` / `m7-graph-monitor.spec.ts`: hypotheses, deterministic
  evidence grading, H3 selection, Evidence Graph and activity/SSE.
- `m8-whatif.spec.ts`: dependency preview, H4 cost confirmation, branch and comparison.
- `m9-blueprint.spec.ts`: H3 selection → composition → citations/trace → export and acceptance;
  another journey includes a rescore-only branch and read-only sharing.
- `playwright.config.ts` explicitly uses synthetic Qloo/scripted LLMs and invokes
  `scripts/e2e-db.mjs`, which drops/recreates a dedicated local test database. Helpers require
  the FIXTURE banner and supply test-only forwarding headers. **Do not repoint or run this
  suite against production, remove its guards, or present its success as live acceptance.**
- `tests/live/providers.test.ts` contains opt-in individual Gemini/Qloo contract/calibration
  checks, not full Agent E2E. DeepSeek trial preparation creates a disposable test database
  and uses synthetic material. Neither is an existing safe production E2E command.

The existing production route is the normal application UI/API using its real supervisor,
Worker, pg-boss, providers and evidence recorder. Do not bypass these layers with a direct
provider call or database insert to manufacture acceptance.

## Concrete blockers to resolve before a live run

1. **Data-write scope:** a new Agent run necessarily creates workspace/project/run/job,
   invocation, evidence, ledger and blueprint records. Literal zero production writes permits
   only inspection of an existing completed genuine run. Even the normal first-visit workspace
   endpoint can create records. If no such run exists, full E2E cannot meet the zero-write
   constraint. Later authorization must explicitly permit one isolated test workspace's new
   records, preserving all existing projects/records, or choose a separately provisioned test
   deployment. No reset, migration, delete/cleanup or secret change is part of this plan.
2. **Actual LLM:** independently confirmed unconfigured, as detailed above. Provisioning an
   approved provider for a later bounded run is required; do not request key values in chat. `apps/worker/src/llm.ts` deliberately returns null for DeepSeek when
   QLOO_MODE=live. `packages/llm-gateway/src/gateway.ts` separately rejects non-synthetic
   DeepSeek input; the existing unit test verifies this. If production uses DeepSeek, real
   Qloo + DeepSeek E2E is blocked by that intentional policy, not Harness readiness. Do not
   switch to fixture mode or remove the guards. Anthropic/Gemini require their existing
   configuration, account/model availability and applicable sharing/approval controls.
3. **Budget enforcement:** the start API offers no custom exploration budget field. Its
   fixed defaults allow up to 40 Harness attempts, 14 LLM attempts, 60,000 output tokens and
   $2 estimated LLM spend; composition separately permits 4/3/20,000/$0.70. These are ceilings,
   not predicted consumption, and not a $0.50 guarantee. Effective persistent grant/workspace/
   experiment caps must already enforce the approved smaller session allowance. If not,
   stop; do not raise/modify production configuration or patch budget rows in place.
4. **Qloo quota:** counters measure Harness attempts, not HTTP requests; workflow resolution,
   retries and MCP-to-CLI fallback can multiply requests. A three-search calibration guard
   does not bound a full workflow. A strict wire-level cap is not currently established for
   production E2E. Confirm an adequate account allowance or separately authorize/review an
   isolated dispatch cap before claiming a hard small HTTP budget.
5. **Permitted evidence:** verify the current allowance for normalized evidence retention,
   downstream use with the configured LLM, and later public display. Existing historical
   notes record restrictions; successful API access alone does not establish these rights.
   Keep raw retention off and do not publish new share links during private validation.

## Low-budget verification plan — prepared, not executed

**Proposed initial allowance:** one isolated project, one exploration and at most one
composition, serial execution, at most US$0.50 in aggregate estimated/reserved LLM spend
across them, subject to existing enforceable caps and owner approval. This may stop before
completion; never raise the cap automatically. Account billing is distinct from estimates.
No optional seed-swap branch, recompose, retry button, parallel experiment or restart to
reset provider counters. Application repairs/fallbacks still consume budget; the unchanged
gateway does not promise zero internal retries for every provider. If zero retries is a hard
requirement, the existing production path is not yet sufficient.

1. Read-only preflight on existing commit 263c7c3: record deployment/instance identity;
   confirm `/api/health/ready` → 200 with db/worker true and `/api/v1/system/status` →
   workerOnline=true, mode=live, qlooReady=true, harnessVersion=0.1.26, real llmModel.
   Correlate latest Worker events, effective provider, grant/cap remaining allowances and
   existing provider account controls. Do not infer LLM readiness from HTTP 200 or model name.
   The optional probe patch is **not a prerequisite** for this recovered deployment.
2. For strict zero-write acceptance, use an already-owned existing run and stored trace/
   graph/blueprint GET endpoints only. Do not visit a route that auto-creates a workspace,
   start/retry/rescore/compose, generate a share link or reset data. Record this as saved-run
   evidence, not a new live experiment. If unavailable, report the blocker.
3. Only after the explicit test-record scope and budget gates are resolved: open the actual
   production UI in one private browser context with an existing authorized grant. Use
   a dedicated test project, no existing customer project. Proposed nonpersonal brief:
   a 30-seat book cafe wants a monthly mystery-and-music evening; inputs “Murder on the Orient
   Express” (book) and “The Beatles” (artist). These are query inputs, not assumed Qloo matches.
   Select only IDs/types returned by the real service; do not invent or auto-accept ambiguity.
4. Click **Interpret brief** and stop at H1 to verify the configured real model's successful
   invocation, validated result, token counts and spend reservation/settlement. If unconfigured,
   denied, invalid or over budget, stop and preserve the failure; do not bypass or retry.
5. **Confirm & discover** → resolve any H2 choices → inspect Discovery → approve the H2b pool
   once. Require actual LIVE or correctly linked CACHE provenance, original source timestamp,
   stored invocation/evidence IDs, supported data types and at least one real downstream
   workflow result beyond search. An empty/unsupported response remains insufficient, not
   fabricated evidence. Verify the actual CLI/MCP route from invocation records.
6. At H3 inspect the hypotheses, deterministic evidence grades, citations and graph. Require
   factual claims to resolve to permitted stored evidence; label model interpretation and
   creative speculation. Select one hypothesis and **Compose blueprint** once, only within
   remaining approved allowance. Check persistence after reload, evidence trace, constraints,
   Markdown export and absence of fixture/scripted labels masquerading as live content.
7. What-if is a later optional acceptance step. Preview before executing; weights-only reuse
   should require zero new Qloo queries, but its comparison narrative can still use an LLM
   and it creates a new branch. Seed changes require reviewed H4 cost/dirty-query approval.
   It is not included in the initial $0.50 proposal.
8. Stop at the first provider/accounting/permission failure, unexpected request fan-out or
   cap boundary. Preserve records/uncertain reservations and record a partial result honestly.
   A cancel request, if authorized, applies only to the test run and cannot undo an already
   dispatched provider request. Do not alter production settings as an automatic stop mechanism.

Read-only evidence routes for an existing authorized workspace include
`GET /api/v1/runs/:runId`, its `/events` SSE stream, `GET /api/v1/experiments/:id/graph`,
`GET /api/v1/evidence/:id/trace`, `GET /api/v1/invocations/:id` and blueprint GET/export routes.
Keep workspace cookies, CSRF tokens, grant codes and share URLs out of transcripts/artifacts.
Use the normal UI for mutations so its existing session/CSRF/admission controls apply.

One additional source risk to inspect during the eventual trace: the adapter is constructed
while startup readiness runs asynchronously, and `createQlooAdapter` currently defaults a
missing version to the string “fixture”. A later heartbeat can report 0.1.26 without changing
that already-created adapter's version metadata. This does not choose fixture transport, but
the actual invocation's Harness version must be checked; it was not changed or presented as
the cause of this readiness incident.

## Final acceptance evidence and optional release

Before declaring hackathon technical acceptance, retain a sanitized run receipt containing
deployment/commit/instance, project/run/invocation/evidence IDs, real provider/model, actual
transport, LIVE/CACHE source lineage, gate decisions, validation outcomes, token/call totals,
estimated and account-reconciled cost, completed/limited state and a traceable blueprint.
Validate the approved judge URL from an external browser, secure sessions/SSE, and both
Chromium/WebKit views. Verify the actual judge access path and approved real-data sample;
an empty shell or a health endpoint is not the functional demo. Repository publication,
judge access, submission materials, rights and current event requirements remain separate
owner-controlled acceptance steps; historical checklists are not current verification.

Do not deploy the optional probe patch to pursue this E2E plan. If later authorized for
release, review the diff, commit/push for actual CI (including target-architecture image
tests), build the approved revision, then separately authorize deployment with unchanged
secrets/roles/configuration. Verify fresh probe fields plus DB/Worker readiness on the same
instance. Roll back to the recorded previous image digest if needed; no database migration,
grant, deletion or restore is required. Local success does not certify that future rollout.
