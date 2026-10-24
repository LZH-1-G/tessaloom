# Tessaloom

**Turn cultural connections into testable creative experiences.**

Tessaloom helps small cafés, bookstores and community venues design original events. Start with a creative brief, discover relationships across cultural worlds, turn surprising combinations into hypotheses, inspect the evidence, change one assumption, and compose an editable experience blueprint.

Built for the Qloo Agentic Hackathon. Owner-provided submission deadline: **October 31, 2026, 11:45 AM Beijing time** (October 30, 11:45 PM EDT).

## Current status

M0–M10-B are implemented. This branch preserves DeepSeek integration (`6e210c2`) and Qloo cache-provenance repairs (`d3ac49a`). See the [submission acceptance report](docs/submission/ACCEPTANCE.md) for current checks and remaining release gates.

- **Interactive demonstration:** synthetic cultural fixtures plus scripted AI, visibly labelled **FIXTURE — not real Qloo data**. These are functioning workflows backed by PostgreSQL, not static mockups or live Qloo claims.
- **Historical Qloo validation:** the [V1 report](docs/research/QLOO_V1_VALIDATION.md) records successful supported Harness workflows and their limitations. Current credential quota/expiry and permitted retention/sharing remain unverified; no new live calls were made during submission preparation.
- **Real AI validation:** exactly two synthetic-input `deepseek-v4-pro` calls passed strict JSON/schema and semantic checks. See the [trial report](docs/DEEPSEEK_LIVE_TRIAL_2026-10-23.md). This does **not** establish a successful real-Qloo-to-DeepSeek end-to-end run.
- **Public demo:** not deployed. Production generation remains off or invitation-controlled, with independent provider spending limits. Precomputed fixture-labelled samples work read-only in the local demo. The production firewall also blocks fixture reads; selecting an approved public-demo mode remains a release gate.

## Try the complete local demo

Requires Node **22.23.3** (`.nvmrc`), pnpm **10.34.7**, Docker with Compose and Chromium/WebKit for browser checks. No Qloo or model API key is needed.

```sh
nvm use
corepack enable
pnpm install --frozen-lockfile
cp -n .env.example .env
docker compose up -d --wait postgres
pnpm build
APP_ENV=development DATABASE_URL_MIGRATOR=postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom pnpm db:migrate
NODE_ENV=production node --env-file=.env scripts/start.mjs
```

Open [localhost:3000](http://localhost:3000). The local `.env.example` uses generated synthetic fixtures, scripted AI and zero paid-provider budgets. Choose another free port in your private `.env` if 3000 is occupied. Keep these development placeholders and services off the public internet. `pnpm dev` starts only the web development server; use the built supervisor above for the complete worker/queue journey.

1. Create a project, then choose **Use the fixture example** in the empty brief.
2. Interpret and confirm the brief; discover cultural threads and review the collision pool.
3. Generate hypotheses, inspect claims and their traceable evidence in the board and graph.
4. Adjust scoring weights or swap a seed; inspect which evidence was reused or recomputed.
5. Compose a blueprint, edit a block, inspect revision history, export Markdown and share read-only.

The [judge walkthrough](docs/submission/JUDGE_WALKTHROUGH.md) provides exact controls, expected outcomes and the safe public-sample path.

![Local fixture blueprint with visible source labels](docs/submission/gallery/sample-blueprint.png)

_Current local read-only blueprint, generated through the scripted pipeline. No real Qloo data._

## What makes it different

A recommendation ends at “you may also like this.” Tessaloom carries a connection through an experiment: an editable hypothesis, explicit claim tests, support/contradiction/insufficient-evidence results, a provenance graph, a controlled What-if comparison, and a practical blueprint. The dependency planner preserves unaffected evidence while recomputing affected queries. Cached evidence retains its **original retrieval time**, separately from reuse time.

Facts, app-derived calculations, model interpretation, creative speculation, user input and fixture data have distinct labels. Affinity is not causation, individual preference, attendance probability or proven demand. Thresholds needing further real-data calibration remain identified as such.

## Architecture

```mermaid
flowchart LR
  Browser --> Web[Next.js web / REST / SSE]
  Web --> DB[(PostgreSQL + pg-boss)]
  DB --> Worker[Persistent agent worker]
  Worker --> Roles[Intent / Discovery / Hypothesis / Critic / What-if / Composer]
  Roles --> Qloo[Typed Qloo adapter / official Harness]
  Roles --> LLM[LLM Gateway / schema validation / spend reservations]
  Qloo --> DB
  LLM --> DB
  DB --> Views[Evidence Graph / comparisons / blueprint revisions / read-only shares]
  Views --> Web
```

Six specialized agent roles share a persisted state machine. Evidence planning and grading use typed claims and deterministic evaluators; LLMs propose, interpret, critique and compose within validated contracts. Confirmation gates, cancellation, job leases, event replay and budgets keep long-running work observable and recoverable.

The worker supports DeepSeek, Anthropic, Gemini and scripted AI. DeepSeek is the preferred **optional live evaluation** provider; no public visitor receives paid access by default. Provider keys are worker-only. The container separates web/worker UIDs and protects mounted secret files. DeepSeek requires explicit request and CNY limits plus current conservative CNY-to-USD accounting; absent or stale configuration fails closed. See [DeepSeek preflight](docs/DEEPSEEK_PREFLIGHT.md) and [live-provider safeguards](docs/LIVE_PROVIDER_VALIDATION.md).

Qloo uses supported official Harness surfaces (`exec`/MCP workflows and `api search`), typed normalization, bounded quotas, cache lineage and fact pointers. Fixture transport is explicit and never a fallback for a failed live provider. Raw Qloo retention remains off. Current permission gaps do not stop the synthetic demonstration; they do stop further real-Qloo use or transmission to third-party models.

## Verification and deployment

```sh
pnpm lint
pnpm typecheck
pnpm test:unit
DATABASE_URL=postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom pnpm test:integration
pnpm build
pnpm test:runtime
pnpm exec playwright install chromium webkit
pnpm test:e2e
INVITE_E2E=1 pnpm test:e2e
pnpm audit --prod --audit-level=high
pnpm check:bundle
```

Tests use disposable local databases; do not point them at production. Live-provider suites are separate and require explicit approval. See [deployment preparation](docs/submission/DEPLOYMENT.md) for the existing Compose architecture, read-only samples, verified hosting options and local-only smoke tests. Hosting purchase/provisioning, public deployment, pushes, repository publication and Devpost submission require owner approval.

## Submission package

- [Copy-ready English Devpost content](docs/submission/DEVPOST.md)
- [Judge walkthrough and screenshots](docs/submission/JUDGE_WALKTHROUGH.md)
- [Deployment and hosting decision](docs/submission/DEPLOYMENT.md)
- [Public-repository and license audit](docs/submission/PUBLIC_READINESS.md)
- [Acceptance report and owner checklist](docs/submission/ACCEPTANCE.md)
- [Architecture](docs/ARCHITECTURE.md), [agent workflow](docs/AGENT_WORKFLOW.md), [API contracts](docs/API_CONTRACTS.md), [security](docs/SECURITY.md), [test plan](docs/TEST_PLAN.md)

## License and attribution

Tessaloom's source is [MIT licensed](LICENSE), copyright 2026 LZH-1-G. Dependencies retain their own licenses; see the [public readiness audit](docs/submission/PUBLIC_READINESS.md). Qloo data is not relicensed by this repository's MIT license. Synthetic demonstration titles and numbers are invented. Development used AI coding assistants; this does not imply that scripted demo output came from a live model.
