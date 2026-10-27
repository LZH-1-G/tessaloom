# Tessaloom

**Weave cultural connections into testable creative experiences.**

Tessaloom helps small cafés, bookstores and community venues design original events from the
cultures their audience loves. You write a brief and name two to six interests (a film, an
author, a musician). Claude agents then work with Qloo's taste data: they discover
connections across cultural worlds, turn surprising pairings into hypotheses, test each claim
against Qloo evidence, and compose a practical experience blueprint. Every statement in that
blueprint says whether it is evidence, AI interpretation or creative speculation.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/). Submission deadline: October
30, 2026, 11:45 PM ET (October 31, 11:45 AM Beijing).

## Status

| Area                                                                                                             | Status                                                                                     | Evidence                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full workflow with **live Qloo data and Claude** (brief → entity selection → discovery → hypotheses → blueprint) | **Verified locally**, 2026-10-26                                                           | [Acceptance report](docs/CLAUDE_SUBSCRIPTION_LOCAL_ACCEPTANCE.md): 5/5 Claude calls valid, 93 cross-world bridges, 5 hypotheses tested against live Qloo evidence, 15-block blueprint whose 7 citations all resolve |
| Same workflow in production through the Anthropic API                                                            | **Prepared, not yet run**                                                                  | [Production runbook](docs/submission/PRODUCTION_FIRST_RUN.md) ($0.50 first-run guard)                                                                                                                               |
| Production service (Northflank): database, queues, Qloo Harness readiness                                        | **Verified** (deployed `859cd9f`)                                                          | [Release handoff](docs/submission/FINAL_RELEASE_HANDOFF.md), [Qloo probe report](docs/QLOO_PROBE_AND_LIVE_ACCEPTANCE.md)                                                                                            |
| Public demo URL                                                                                                  | **Live**: <https://p01--tessaloom--mpfcqkyl42yb.code.run> (agent runs are invitation-only) | Public smoke and Chromium/WebKit checks, 2026-10-26                                                                                                                                                                 |
| Local demo without any keys (synthetic data, scripted AI)                                                        | **Verified**                                                                               | Quick start below; Chromium + WebKit journeys in CI                                                                                                                                                                 |

## How it works

1. **Brief.** The user describes the venue, audience goal, constraints and interests. Claude
   (role **R1**) interprets it into an intent frame and flags ambiguity ("the novel or the film?").
2. **Entity selection.** Qloo search and describe resolve each interest. The user picks the
   intended entity; nothing ambiguous is chosen for them.
3. **Discovery.** Qloo recommendations thread each interest into other worlds (books, music,
   film, places). Items reached from more than one interest, or sharing Qloo themes across worlds,
   become **collision candidates**. A tension slider trades familiar against surprising pairs.
4. **Hypotheses.** Claude (**R3**) writes creative hypotheses from the chosen pool. Each carries
   typed, testable claims. Tessaloom plans the Qloo query for each claim, and **deterministic
   evaluators** grade the results as supports / contradicts / neutral / insufficient. Claude
   (**R4**) critiques the evidence; weak ideas are revised or retired.
5. **What-if.** Change one variable (weights, a seed, the tension). A dependency planner reuses
   unaffected evidence, recomputes only what changed, and Claude (**R5**) explains the difference.
6. **Blueprint.** Claude (**R6**) composes an editable plan whose blocks cite stored evidence. A
   traceability check rejects unresolved citations. Users edit, export Markdown and share read-only.

## Qloo integration

Tessaloom uses Qloo only through the official `@qloo/qloo-harness` (0.1.26) surfaces supported by
the event: MCP/`exec` workflows and `api search`.

| Purpose           | Qloo workflow                                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolve interests | `search`, `describe` (ambiguity goes to the user)                                                                                                                                                                                   |
| Discovery threads | `recommend` from each interest into each target world                                                                                                                                                                               |
| Bridge themes     | `entity_tags` (bounded enrichment)                                                                                                                                                                                                  |
| Claim tests       | `recommend` (cross-world affinity), `rank` (shortlist fit), `compare_audiences` (audience bridge), `entity_tags` (theme resonance), `where_popular` (location fit), `trends` (momentum), `audience_demographics` (audience profile) |

Responses are normalized into typed records with provenance: request hash, retrieval time,
origin (live, cache or fixture) and a pointer to the fact used. Cached evidence keeps its
original retrieval date. Raw responses are not retained (`QLOO_RAW_RETENTION=off`), and no
Qloo response data is stored in this repository ([data-rights review](docs/submission/DATA_RIGHTS_REVIEW.md)).
Calls are rate-limited, budgeted per run and per day, and retried a bounded number of times.

## Claude agents

Five Claude roles (R1 intent, R3 hypotheses, R4 critic, R5 What-if narrative, R6 composer)
run inside a persistent, recoverable state machine with human confirmation gates. R2,
discovery, is Qloo-driven. The **LLM gateway** gives every call:

- **Structured output.** JSON Schema generated from Zod, plus semantic validators: grounded
  entity ids, no causal or individual-level claims, no sensitive traits. At most one repair.
- **A spend reservation before dispatch.** Global, workspace, experiment, run and invite-grant
  caps. Unknown outcomes stay charged, and an unexpected serving model fails closed.
- **Recorded invocations.** Role, prompt version, model, tokens, latency and validation status;
  no private reasoning is stored.

Production uses **Claude Sonnet 5.5 through the Anthropic API** (`LLM_PROVIDER=anthropic`).
For the developer's own local testing only, `LLM_PROVIDER=claude-subscription` runs the
official Claude Agent SDK on the developer's Claude Pro/Max login. It is refused outside
development and test, never runs beside an API key, and is absent from the production image
([why and how](docs/CLAUDE_SUBSCRIPTION_LOCAL_ACCEPTANCE.md)). DeepSeek, Gemini and a scripted
provider are also supported.

## Technical highlights

- **Evidence you can trace.** Every claim links to the Qloo request, the fact pointer and the
  grading rule. The Evidence Graph shows entities → hypotheses → claims → evidence.
- **Honest labels everywhere.** Qloo data, computed values, AI interpretation, creative
  speculation, user input and synthetic fixtures are visually distinct. A production firewall
  refuses fixture data.
- **Dependency-aware What-if.** Branches reuse evidence without making it look freshly retrieved.
- **Read-only stories.** A share link or demo sample shows the brief, the Qloo discovery, the
  tested hypotheses and the blueprint, with no identifiers or raw Qloo values.
- **Operable.** Web and worker run as separate OS identities; secrets are worker-only. Health and
  readiness probes, an SSE activity stream, cancellation, retries and invite-only paid access are
  built in.

## Quick start (no keys, synthetic data)

Requires Node **22.23.3** (`.nvmrc`), pnpm **10.34.7** and Docker.

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

Open [localhost:3000](http://localhost:3000), create a project and choose **Use the fixture
example**. Every synthetic stage shows **FIXTURE — not real Qloo data**. See the
[judge walkthrough](docs/submission/JUDGE_WALKTHROUGH.md).

**Live mode** needs your own event Qloo key in the Harness config (`QLOO_HOME`), plus
`QLOO_MODE=live` and the trusted base URL, and an Anthropic API key for the worker
(`LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-sonnet-5-5`). Set non-zero LLM budget caps.
Variables are documented in [`.env.example`](.env.example). Never put keys in the repository
or the browser.

## Verification

```sh
pnpm lint && pnpm typecheck && pnpm test:unit
DATABASE_URL=postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom pnpm test:integration
pnpm build && pnpm test:runtime
pnpm exec playwright install chromium webkit && pnpm test:e2e && INVITE_E2E=1 pnpm test:e2e
pnpm audit --prod --audit-level=high && pnpm check:bundle
```

CI runs all of these on Linux AMD64, plus gitleaks, osv-scanner and a Docker image smoke test.
Tests use disposable local databases; never point them at production.

## Deployment

One container: a supervisor runs the Next.js web process and the worker as separate
non-root users, against managed PostgreSQL. The selected host is Northflank
([runbook](docs/NORTHFLANK_RUNBOOK.md)). Release, public exposure, Anthropic key setup and the
final paid acceptance are in the [production runbook](docs/submission/PRODUCTION_FIRST_RUN.md).

## Security and limitations

- Provider keys live only in the worker. The web bundle is scanned for leaked secrets. Shares are
  peppered-hash tokens with expiry and immediate revocation. Paid generation needs an invite
  grant with run and spending caps. See [SECURITY.md](docs/SECURITY.md).
- Qloo affinities are aggregate taste signals. They do not predict attendance or sales,
  describe individuals, or show causation. Hypotheses and most blueprint text are AI
  interpretation or speculation, and are labelled as such.
- Live data can yield too few cross-world bridges for some interest pairs (`POOL_TOO_SMALL`). The
  app explains this and suggests adding or broadening interests.
- Evaluator thresholds are calibrated on a small number of live runs.

## Submission package

[Devpost draft](docs/submission/DEVPOST.md) · [Demo script](docs/submission/DEMO_SCRIPT.md) ·
[Judge walkthrough](docs/submission/JUDGE_WALKTHROUGH.md) ·
[Data-rights review](docs/submission/DATA_RIGHTS_REVIEW.md) ·
[Publication checklist](docs/submission/PUBLIC_READINESS.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Agent workflow](docs/AGENT_WORKFLOW.md) ·
[API contracts](docs/API_CONTRACTS.md)

## License and attribution

Tessaloom's source is [MIT licensed](LICENSE), copyright 2026 LZH-1-G. Dependencies keep their
own licenses ([audit](docs/submission/PUBLIC_READINESS.md)). Cultural data shown by the app
comes from Qloo and is not covered by this repository's license. Development used AI coding
assistants (Claude Code and Codex).
