# Claude subscription — local Qloo + Claude acceptance (2026-10-26)

## Conclusion

**The real Tessaloom workflow completed locally with live Qloo data and Claude, billed to the
owner's Claude Pro subscription allowance, not to API credits.** The full path ran:
Brief → Entity Selection → Discovery → Hypothesis → Blueprint. All five Claude calls returned
schema-valid, semantically valid output on the first attempt. The blueprint's 7 citations all
resolve to stored live-Qloo evidence records.

This is a **local, personal-use validation** of the application's orchestration, evidence
handling, tracing, persistence and frontend. It does **not** validate the production
`AnthropicProvider` (Messages API) path or the Northflank deployment. Those still require a
Claude Console API key (see [Public deployment](#public-deployment-needs-an-api-key)).

No paid API call, production change, commit, push, merge or deployment was made.

## Authentication and billing (verified, no secrets read)

| Check | Result |
| --- | --- |
| `claude auth status` (stripped environment) | `authMethod: claude.ai`, `apiProvider: firstParty`, `subscriptionType: pro` |
| Agent SDK `accountInfo()` | `subscriptionType: "Claude Pro"`, `apiProvider: firstParty`, no API-key source |
| Agent SDK `system/init` | `apiKeySource: "none"` (claude.ai OAuth; an API key would report `ANTHROPIC_API_KEY`) |
| `ANTHROPIC_API_KEY` in any environment | Absent |
| Paid extra usage | `overageStatus: rejected`, `overageDisabledReason: org_level_disabled` |
| Allowance observed before the workflow | 5-hour window 29%, 7-day window 7% |

The CLI child reads the owner's own stored login (keychain), not the desktop session's
credentials. No OAuth token, session credential or key was printed, copied or stored.

## Policy basis

Anthropic's [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and
[legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) pages (read
2026-10-26) state:

- Pro/Max usage limits "assume ordinary, individual usage of Claude Code and the Agent SDK".
- Developers may not offer claude.ai login in their products, or route requests through
  Free/Pro/Max credentials *on behalf of their users*. Products built on the Agent SDK should use
  API-key authentication.
- Sign-in must complete through Anthropic's own flow, and credentials must not be collected,
  stored or intermediated.

Tessaloom therefore treats subscription mode as **owner-only, local personal use**. It runs the
unmodified Claude Code binary signed in with the owner's own plan, on the owner's machine, for
the owner's own experiments. It is never offered to other users and never deployed.

## Implementation

New provider `ClaudeSubscriptionProvider` (`LLM_PROVIDER=claude-subscription`), in
`packages/llm-gateway/src/providers/claude-subscription.ts`. It uses the official
`@anthropic-ai/claude-agent-sdk@0.3.296` `query()` with structured output (`outputFormat`).

Guards (all unit-tested with a fake SDK; no live calls in tests):

- **Account gate before send.** The user turn is withheld until `accountInfo()` reports a
  first-party Pro/Max plan with no API-key source. Otherwise the call fails closed with
  `requestSent=false`. A later `init` reporting an API key also aborts.
- **No silent paid fallback.** A `rate_limit_event` showing overage, or a rejected allowance,
  aborts with a non-retryable error. The gateway's cross-model fallback is disabled for this
  provider. An API key beside subscription mode is a configuration error.
- **Credential-free child.** The CLI child gets only `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`,
  a fixed `PATH` and the output cap. API keys, bearer and OAuth overrides, and base URLs are
  never forwarded.
- **Isolation.** No tools, MCP, settings sources or session persistence, in an empty temp
  directory. The system prompt is Tessaloom's role prompt, so the app does not present itself as
  Claude Code.
- **Single serving model.** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` removes the CLI's
  auxiliary Haiku call. Any extra model in `modelUsage` makes the gateway fail closed
  (`UNEXPECTED_MODEL`).
- **Bounded.** A worker-lifetime request cap (1–30), an approved model list
  (`claude-sonnet-5-5`, `claude-opus-5-5`), and the existing M10-A reservations. Each call
  reserves an upper bound at list price and settles at **$0 API charge**. The list-price
  equivalent is recorded as `notionalApiListUsd`.
- **Local only, four layers.** The worker env schema, worker gateway factory and supervisor all
  refuse it outside `APP_ENV=development|test`. The production bundle marks the SDK external, and
  the runtime image does not ship it.

The SDK is a **root dev dependency**. The lockfile remains valid for the production image's
`pnpm@10.34.7 install --frozen-lockfile`.

## Measured workflow

Live Qloo (Harness 0.1.26, trusted `https://hackathon.api.qloo.com`, raw retention off), a
dedicated local database, and web bound to 127.0.0.1. The UI was driven in the browser.

| Run | Seeds | Result | LLM calls | Qloo calls |
| --- | --- | --- | ---: | ---: |
| Exploration 1 | *Norwegian Wood* (book, 1987) + Nujabes | `FAILED / POOL_TOO_SMALL` | 1 | 19 |
| Exploration 2 | *Spirited Away* (film, 2001) + Joe Hisaishi | `COMPLETED` (5 hypotheses, 10 claims) | 3 | 27 |
| Composition | "Which Ghibli Next? Café Vote", recurring series | `COMPLETED` (15 blocks) | 1 | 0 |

| Call | Validation | Input / cached / output tokens | Latency | API charge | List-price equivalent |
| --- | --- | --- | ---: | ---: | ---: |
| R1 intent (run 1) | VALID | 2,951 / 0 / 439 | 5.2 s | $0 | $0.0118 |
| R1 intent (run 2) | VALID | 1,063 / 1,885 / 383 | 6.8 s | $0 | $0.0067 |
| R3 generate | VALID | 9,894 / 0 / 4,885 | 32.0 s | $0 | $0.0736 |
| R4 critique | VALID | 4,676 / 0 / 1,277 | 10.2 s | $0 | $0.0245 |
| R6 compose | VALID | 4,050 / 0 / 2,200 | 19.4 s | $0 | $0.0321 |

There were zero repairs, retries or fallbacks. The five spend reservations (max $0.176, total
$0.502) all settled at $0. Four more subscription requests were used for provider smoke and
diagnostics before the workflow. List prices come from the repository's
`PRICE_SOURCE_DATE=2026-10-20` table. They are an estimate, not a billing statement.

Persistence and traces: 125 run events, 46 Qloo tool invocations (45 `ok`), 46 snapshot metadata
rows (`raw_retained=false`, 0 fixtures), 10 evidence records (7 supports, 1 contradicts,
1 neutral, 1 insufficient), and 1 blueprint revision. Stack logs contain no credential patterns,
and no SDK transcripts were persisted. Details:
[evidence JSON](evidence/claude-subscription-local-2026-10-26.json).

Frontend: the brief interpretation (R1 flagged the *Norwegian Wood* ambiguity), Qloo
candidate disambiguation, the Discovery canvas labelled "Qloo data", the collision pool, the
Hypothesis lab with per-claim evidence counts, and a blueprint at 13% evidence-backed / 53% AI
interpretation / 33% labelled speculation, with an evidence appendix showing "Qloo (live)".

### Product finding: live collision pools can be empty

Run 1 is a real outcome, not a provider failure. All Qloo calls succeeded, but a bridge needs two
entities from different worlds, reached from different seeds, that share a tag. Only 8 of 60
thread items are tag-enriched (`MAX_TAG_ENRICHMENT = 8`). The only cross-seed shared tags were
place-rating tags between two places, which is the same world. The algorithm was not changed:
raising enrichment trades directly against the shared Qloo quota and needs an owner decision.
The UI should explain this outcome and suggest adding a third interest.

## Separation of validation levels

| Level | Status |
| --- | --- |
| Offline unit/regression (provider guards, gates, supervisor) | **Validated.** 26 new tests; full suite 461 passing; typecheck, lint and build pass |
| Local real Qloo + Claude via subscription (application path) | **Validated** (this report) |
| Production `AnthropicProvider` (Messages API, API key) with real calls | **Not validated.** Requires API billing |
| Northflank public demo with Claude | **Not validated.** Requires API key, approval and deployment |
| Production Qloo readiness | Validated earlier by the owner's probes (see QLOO_PROBE_AND_LIVE_ACCEPTANCE.md) |

## Public deployment needs an API key

Public Tessaloom inference must not use the owner's subscription. The Northflank demo needs
`LLM_PROVIDER=anthropic` with an `ANTHROPIC_API_KEY` from the Claude Console, delivered as a
worker-only runtime secret. A proposed, **not applied** configuration is in
[`deploy/northflank.anthropic.env.example`](../deploy/northflank.anthropic.env.example).

Proposed first paid experiment, pending explicit authorization: $0.50 total budget,
`claude-sonnet-5-5`, serial (`MAX_WORKING_RUNS=1`), invite-only grant, and existing bounded
retries (one repair, one truncation retry). The fail-closed M10-A ledger stays in place. At the
measured token counts, one complete workflow is about $0.14 at list price, and the largest single
reservation was $0.18. Messages API token counts will differ from the Agent SDK's, so
re-measure on the first run.

## Reproduce locally

```bash
DATABASE_URL=postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom_e2e_subscription node scripts/e2e-db.mjs
```

Start the stack with `APP_ENV=development`, `LLM_PROVIDER=claude-subscription`,
`LLM_MODEL=claude-sonnet-5-5`, `CLAUDE_SUBSCRIPTION_LOCAL_APPROVED=on`,
`CLAUDE_SUBSCRIPTION_MAX_REQUESTS=20`, `QLOO_MODE=live`, `QLOO_HOME=$HOME/.qloo`, the hackathon
`QLOO_BASE_URL`/`QLOO_TRUSTED_BASE_URL`, and `HOSTNAME=127.0.0.1`. The supervisor builds the child
`PATH` from the Node binary's real directory, which must also contain `qloo`. With Homebrew Node,
use a directory holding a copy of `node`, its `../lib/libnode.*.dylib`, and a `qloo` symlink. Sign
in with `claude` (your own plan) first; do not set `ANTHROPIC_API_KEY`.
