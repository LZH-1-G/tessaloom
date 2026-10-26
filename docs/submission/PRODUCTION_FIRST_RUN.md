# Production first run — Claude API on Northflank (prepared, not executed)

**Status: ready for owner approval. Nothing here has been executed in production.** No API key
has been created or stored, no production variable changed, no paid call made, and nothing merged
or deployed. Every step marked **OWNER** needs your explicit go-ahead.

The local subscription run on 2026-10-26 proved the application path
([report](../CLAUDE_SUBSCRIPTION_LOCAL_ACCEPTANCE.md)). This runbook repeats that exact scenario
once in production, through the official Anthropic API, under a $0.50 total ceiling. The resulting
blueprint then becomes the public, read-only, real-data demo.

## 1. What is verified before spending anything

| Check | Evidence |
| --- | --- |
| `AnthropicProvider` request shape matches the current Messages API | Unit tests with a fake client: model id, cached system block, `thinking: {type: "adaptive"}`, `output_config.effort` + `output_config.format` (json_schema), no sampling params, streaming above 16k output tokens, `stop_details` refusal mapping |
| All six role schemas are accepted by structured outputs | `tests/unit/llm-gateway.test.ts`: every object `additionalProperties: false`; no `minLength`/`maxLength`/numeric bounds/`maxItems`/`uniqueItems` sent (the SDK's `zodOutputFormat` strips them and they are validated client-side) |
| Models and prices | `claude-sonnet-5-5` $2 input / $2.50 5-min cache write / $0.10 cache read / $10 output per MTok; `claude-opus-5-5` $4 / $5 / $0.20 / $20. Re-checked against the official pricing page on 2026-10-26 and identical to `PRICES` |
| Retries and fallback stay under the ledger | SDK `maxRetries: 0`; server-side fallback disabled by constructor guard; the gateway does one repair and one truncation retry, each reserved before dispatch; an unexpected serving model fails closed |
| Key stays in the worker | Supervisor allowlist sends `ANTHROPIC_API_KEY` to the worker only; the web env schema rejects every `*_API_KEY`; the CI build scans the browser bundle for a sentinel key |
| Subscription mode cannot run in production | Refused by the worker env schema, worker factory and supervisor for any `APP_ENV` other than development/test; the SDK is not bundled and not in the image (unit tests) |
| Judge grant lifecycle | Local rehearsal: create (1 day, 1 run, $0.50; code shown once, hash stored), list, `spend today`, revoke; out-of-range values and a short pepper rejected |

Not verifiable without spending: a real Messages API response, real token counts on the API path,
and Northflank behaviour with a key present. These are what the first run measures.

## 2. Exact runtime configuration (OWNER)

Apply [`deploy/northflank.anthropic.env.example`](../../deploy/northflank.anthropic.env.example)
over the current runtime variables. The only differences from today's
[`northflank.env.example`](../../deploy/northflank.env.example):

| Variable | Today | First run |
| --- | --- | --- |
| `LLM_PROVIDER` | `deepseek` | `anthropic` |
| `LLM_MODEL` / `LLM_FALLBACK_MODEL` | (unset) | `claude-sonnet-5-5` / `claude-sonnet-5-5` |
| `LLM_MODE` | `economy` | `standard` |
| `GLOBAL_DAILY_LLM_USD` / `WORKSPACE_DAILY_LLM_USD` / `EXPERIMENT_LLM_USD` | `0` | `0.50` |
| `GLOBAL_DAILY_QLOO_CALLS` | `0` | `60` |
| `RUN_ACCESS` | `off` | `off`, then `invite` only for the run window (§4) |
| `CLAUDE_SUBSCRIPTION_*` | (unset) | `off` / `0`, explicit |

Secret: create a **dedicated** Claude Console API key in its own workspace. Add it as
`ANTHROPIC_API_KEY` in Northflank's **restricted runtime secrets** for this service, never in a
secret group shared with other services, build arguments, the repo or chat. Keep the existing
`SESSION_SECRET` and `SHARE_TOKEN_PEPPER`; changing the pepper invalidates grants and shares.

Independent backstop (OWNER, Claude Console): set a low monthly spend limit on that workspace
(for example $5). The application ledger is an estimate, not a provider invoice ceiling.

## 3. The $0.50 guard, layer by layer

1. **Spend ledger (M10-A).** Before every attempt (first try, repair, truncation retry) the worker
   reserves the call's upper bound against the global-daily, workspace-daily and experiment caps
   (all $0.50) and the grant cap ($0.50). If the reservation does not fit, the call is never sent.
   Unknown outcomes keep the full reservation charged.
2. **Grant.** One grant: `--days 1 --runs 1 --usd 0.50`. One run admission, revocable at once.
3. **Serial.** `MAX_WORKING_RUNS=1`, `MAX_ACTIVE_RUNS_PER_WORKSPACE=1`, `WORKSPACE_DAILY_RUNS=1`.
4. **Run budget.** Per-run limits from `AGENT_WORKFLOW.md` §7 (exploration ≤ 14 LLM calls,
   ≤ 40 Qloo calls; composition ≤ 3 LLM calls, ≤ 4 Qloo calls).
5. **Provider.** No SDK retries, no server-side fallback, approved model only.
6. **Console spend limit**, outside the application.

Expected cost: the same scenario's measured tokens price at **≈ $0.14** for the full workflow
(R1 $0.007 cached, R3 $0.074, R4 $0.024, R6 $0.032). The largest single reservation was $0.18
(R3, 12k output cap). Messages API token counts differ from the Agent SDK's, so treat $0.14 as an
estimate. In the worst case, with every call at its output cap plus a repair, the ledger refuses
the next reservation and the run ends `COMPLETED_WITH_LIMITS` or `FAILED` before $0.50. It never
overspends to finish.

## 4. Production E2E script (OWNER approves each step; run once)

Preconditions: PR #18 reviewed and merged, the image deployed with the §2 variables, the key
present, `RUN_ACCESS=off`, and `/api/health/ready` 200 with `qlooReady: true`.

1. From a private terminal (recording off), in a Northflank job or one-off command against the
   service's runtime env: `node packages/db/dist/admin.mjs grant create --label first-run --days 1
   --runs 1 --usd 0.50`. Keep the code private, then set `RUN_ACCESS=invite`.
2. In a fresh browser: open the public URL, enter the access code, create a project
   *Spirited sound evenings* (Café).
3. Brief, as in the local run: title *Spirited sound evenings*; challenge *"A 40-seat café wants
   a recurring monthly weekday evening that brings animated-film lovers and film-score music fans
   together, to attract new regular visitors on a quiet night."*; interests **Spirited Away**
   (Film) and **Joe Hisaishi** (Music artist); capacity 40; low budget; 90 minutes; goal
   *Attract new weekday regulars*. **Interpret brief → Confirm & discover.**
4. Entity selection: **Spirited Away (2001)** (Miyazaki / Studio Ghibli) and **Joe Hisaishi**
   (Qloo's exact-name pick). **Confirm choices.**
5. Collision pool: accept the proposed pool (locally 93 candidates, 3 selected at τ = 0.5).
   **Generate hypotheses with this pool.**
6. Hypothesis lab: select the top supported hypothesis (locally "Which Ghibli Next? Café Vote").
   **Compose blueprint**, choose format **Recurring series**, then **Compose blueprint** in the dialog.
7. Immediately afterwards: `grant revoke <id>`, set `RUN_ACCESS=off`, then run `spend today`.

**Stop conditions:** any failed reservation, provider auth or 4xx error, unexpected model, more than
60 Qloo calls, or `spend today` > $0.50. On any of these, revoke the grant, set `RUN_ACCESS=off`,
and record the outcome. Never retry under the same approval.

**Pass criteria:** brief, entity selection, discovery, pool, hypotheses and blueprint complete;
every LLM invocation `VALID` (repairs allowed if they succeed); blueprint citations all resolve,
with origin "Qloo (live)"; `spend today` ≤ $0.50, matching the Console usage page within rounding.

**Evidence to record (no secrets):** run IDs and states, per-call role/model/tokens/latency/
estimated cost, Qloo call counts, `spend today`, the Console-reported charge, and screenshots of
the blueprint traceability header and evidence appendix. Save as
`docs/evidence/production-first-run-<date>.json` plus a short report. Keep production-validated
results separate from the local subscription results.

**Rollback:** `RUN_ACCESS=off`, budgets back to `0`, remove `ANTHROPIC_API_KEY`, revoke grants.
Stored results stay readable. These are runtime variables, not image contents: restoring the
values in `northflank.env.example` returns the service to its current zero-budget configuration.

## 5. Public demo route and judge access

- **Public read-only sample (no spend).** On the blueprint page choose **Share read-only** and set
  an expiry that covers judging (the API allows 1–90 days, so pick 30+ to run past Nov 16). The
  `shareLinkId` is in the creation response and in `GET /api/v1/projects/<projectId>/share-links`
  from the owner's browser session. Feature it with `admin.mjs sample feature <shareLinkId>`.
  Visitors then open it under **Demo samples**, with no workspace, code or model call. It is real
  live-Qloo content, so the production fixture firewall stays unchanged. `sample unfeature`
  withdraws it.
- **Optional live judge access.** After reviewing the first run's real cost, issue one grant per
  judging session (proposed `--days 7 --runs 2 --usd 0.40`, raised only with measured headroom).
  Set the global/workspace/experiment caps to cover all active grants. Codes go only into
  Devpost's private testing-instructions field.
- Re-check `spend today` and the Console usage daily during judging. Revoke on suspected disclosure.

## 6. Open owner decisions

- Approve: merge PR #18, deploy, create the API key, apply §2, run §4 once.
- Confirm Qloo-derived blueprint content may be shown publicly. The hackathon kit asks for
  results to be presented with source and limits; raw retention stays off.
- Decide whether judges get live generation (§5) or the read-only sample only.
