# Production release and the final paid Claude acceptance (prepared, not executed)

**Status: ready for owner approval. Nothing here has been executed in production.** No API key has
been created, requested or configured, no production variable or port changed, and no paid call
made. Every step marked **OWNER** needs your explicit go-ahead. The paid Claude call is
deliberately the **last** step. Everything before it is free.

The local run on 2026-10-26 (live Qloo, Claude Sonnet 5.5 on the owner's subscription) proved the
application path ([report](../CLAUDE_SUBSCRIPTION_LOCAL_ACCEPTANCE.md)). Production repeats that
scenario once through the official Anthropic API under a $0.50 ceiling. Its result becomes the
public, read-only, real-data story sample.

## 0. Production as inspected (read-only, 2026-10-26)

| Item | Observed |
| --- | --- |
| Service | `default/tessaloom`, 1 instance, plan `nf-compute-20` (build `nf-compute-400-16`) |
| Deployed commit | `39c0fe5` (PR #18 merged), build SUCCESS, deployment COMPLETED |
| Readiness probe | HTTP `/api/health/ready` on port 3000, every 20 s |
| Port `p01` (HTTP 3000) | **`public: false`**. `p01--tessaloom--mpfcqkyl42yb.code.run` does not answer from outside |
| LLM | `unconfigured` (no provider key). Runs would stop as `LLM_NOT_CONFIGURED` (tested) |

**Blocker for any public demo:** port `p01` must be made public (OWNER, §2.1).

## 1. What is verified before spending anything

| Check | Evidence |
| --- | --- |
| `AnthropicProvider` request shape matches the current Messages API | Fake-client unit tests: model id, cached system block, `thinking: {type: "adaptive"}`, `output_config.effort` + `output_config.format` (json_schema), no sampling params, streaming above 16k output tokens, `stop_details` refusal mapping |
| All six role schemas fit structured outputs | `tests/unit/llm-gateway.test.ts`: every object `additionalProperties: false`; no `minLength`/`maxLength`/numeric bounds/`maxItems`/`uniqueItems` sent (the SDK's `zodOutputFormat` strips them and they are validated client-side) |
| Models and prices | `claude-sonnet-5-5` $2 input / $2.50 5-min cache write / $0.10 cache read / $10 output per MTok; `claude-opus-5-5` $4 / $5 / $0.20 / $20. Re-checked against the official pricing page 2026-10-26; identical to `PRICES` |
| Bounded retries | SDK `maxRetries: 0`; server-side fallback disabled by constructor guard; the gateway does at most one repair and one truncation retry, each reserved before dispatch; an unexpected serving model fails closed |
| Key isolation | Supervisor allowlist sends `ANTHROPIC_API_KEY` to the worker only; the web env schema rejects every `*_API_KEY`; CI scans the browser bundle for a sentinel key |
| Unconfigured LLM fails safely | Integration test: `LLM_NOT_CONFIGURED`, zero attempts, invocations and reservations. Status reports `llmConfigured: false` and names no model |
| Subscription mode cannot run in production | Refused by worker env schema, worker factory and supervisor outside development/test; SDK not bundled and absent from the image |
| Read-only story sample | Integration + Chromium/WebKit tests: full story, no ids or raw Qloo values, fixture wording by experiment mode, per-link revocation |
| Judge grant lifecycle | Local rehearsal: create (code shown once, hash stored), list, `spend today`, revoke; bad values rejected. Browser invite flow covered by `INVITE_E2E` |

Not verifiable without spending: a real Messages API response, real API token counts, and
Northflank behaviour with a key present. The final step measures exactly these.

## 2. Free production steps (OWNER approves each)

### 2.1 Release the reviewed code and open the public URL

1. Review and merge the readiness PR (this branch). Northflank builds `main` and deploys it.
2. Check `/api/health/ready` = 200 and `/api/v1/system/status` shows `qlooReady: true` and
   `llmConfigured: false`.
3. In Northflank → service `tessaloom` → Networking, set port `p01` (HTTP 3000) to **Public**. Keep
   the Northflank-managed `code.run` domain and TLS. Keep `TRUSTED_PROXY_HOPS=0`: per-IP limits then
   apply to the edge address, which is conservative for judging traffic.
4. From an outside network: `https://p01--tessaloom--mpfcqkyl42yb.code.run/` loads,
   `/api/health/ready` is 200, `RUN_ACCESS=off` shows "New AI runs are paused", and nothing spends.

### 2.2 Prepare the paid configuration without a key

Apply [`deploy/northflank.anthropic.env.example`](../../deploy/northflank.anthropic.env.example)
with **`RUN_ACCESS=off`**. Without `ANTHROPIC_API_KEY` the gateway stays unconfigured, so this
step still cannot spend. Differences from today's [`northflank.env.example`](../../deploy/northflank.env.example):

| Variable | Today | Final acceptance |
| --- | --- | --- |
| `LLM_PROVIDER` | `deepseek` | `anthropic` |
| `LLM_MODEL` / `LLM_FALLBACK_MODEL` | (unset) | `claude-sonnet-5-5` / `claude-sonnet-5-5` |
| `LLM_MODE` | `economy` | `standard` |
| `GLOBAL_DAILY_LLM_USD` / `WORKSPACE_DAILY_LLM_USD` / `EXPERIMENT_LLM_USD` | `0` | `0.50` |
| `GLOBAL_DAILY_QLOO_CALLS` | `0` | `60` |
| `MAX_WORKING_RUNS` / `MAX_ACTIVE_RUNS_PER_WORKSPACE` / `WORKSPACE_DAILY_RUNS` | `1` / `1` / `1` | unchanged |
| `RUN_ACCESS` | `off` | `off`; `invite` only during §4 |
| `CLAUDE_SUBSCRIPTION_LOCAL_APPROVED` / `_MAX_REQUESTS` | (unset) | `off` / `0`, explicit |

Keep `SESSION_SECRET` and `SHARE_TOKEN_PEPPER` unchanged; changing the pepper invalidates grants
and shares.

## 3. Anthropic Console (OWNER, only when approving the final step)

1. Create a **dedicated workspace** for Tessaloom and a key in it. The key is never pasted into
   chat, the repo, build arguments, logs or a shared secret group.
2. Set a **workspace spend limit** (for example $5/month) as an independent backstop. The
   application ledger estimates cost; it is not a provider-side guarantee.
3. Add the key as `ANTHROPIC_API_KEY` in this service's **restricted runtime secrets**, then
   restart. Expect `llmConfigured: true` and `llmModel: claude-sonnet-5-5`, with no spend.

## 4. Final paid acceptance (OWNER approves; run once, last)

### The $0.50 guard, layer by layer

1. **Spend ledger (M10-A).** Before every attempt (first try, repair, truncation retry) the worker
   reserves the call's upper bound against the global-daily, workspace-daily and experiment caps
   ($0.50 each) and the grant cap ($0.50). If it does not fit, the call is never sent. Unknown
   outcomes keep the full reservation.
2. **Grant:** `--days 1 --runs 1 --usd 0.50`. One run admission, revocable at once.
3. **Serial:** one working run, one active run per workspace, one run per workspace per day.
4. **Run budget:** exploration ≤ 14 LLM / 40 Qloo calls; composition ≤ 3 LLM / 4 Qloo calls.
5. **Provider and retries:** no SDK retries, no server-side fallback, approved model only. A
   transient error (429/5xx) gets at most one same-model gateway retry, and the step is retried
   at most twice by the queue (`retryLimit: 2`). Every attempt reserves first, so rate limits
   or outages end in `LLM_UNAVAILABLE`/`STEP_RETRIES_EXHAUSTED`, never in unbounded spend. A
   Tier 1 Anthropic workspace's rate limits are far above this serial workload.
6. **Console spend limit**, outside the application.

Expected cost **≈ $0.14** for the full workflow (local measurement at API list prices: R1 $0.007
cached, R3 $0.074, R4 $0.024, R6 $0.032). The largest single reservation was $0.18 (R3, 12k output
cap). API token counts differ from the Agent SDK's. In the worst case the ledger refuses the next
reservation and the run stops early. It never overspends to finish.

### Steps

1. Private terminal, recording off, in a Northflank job or one-off command with the service's
   runtime env: `node packages/db/dist/admin.mjs grant create --label final-acceptance --days 1
   --runs 1 --usd 0.50`. Keep the code private. Set `RUN_ACCESS=invite`.
2. Fresh browser → public URL → enter the code → create project **Spirited sound evenings** (Café).
3. Brief: title *Spirited sound evenings*; challenge *"A 40-seat café wants a recurring monthly
   weekday evening that brings animated-film lovers and film-score music fans together, to attract
   new regular visitors on a quiet night."*; interests **Spirited Away** (Film), **Joe Hisaishi**
   (Music artist); capacity 40; low budget; 90 minutes; goal *Attract new weekday regulars*.
   **Interpret brief → Confirm & discover.**
4. Entity selection: **Spirited Away (2001)** and **Joe Hisaishi** (Qloo's exact-name pick).
   **Confirm choices.**
5. Pool: accept the proposal (locally 93 candidates, 3 selected at τ = 0.5). **Generate hypotheses
   with this pool.** If it stops as `POOL_TOO_SMALL`, stop there and record it. Do not retry
   under this approval.
6. Select the top supported hypothesis → **Compose blueprint** → **Recurring series** →
   **Compose blueprint**.
7. Immediately: `grant revoke <id>`, `RUN_ACCESS=off`, `spend today`, and compare with the Console
   usage page.

**Stop conditions:** a refused reservation, provider auth/4xx error, unexpected model, more than 60
Qloo calls, or `spend today` > $0.50. Revoke, set access off, record. Never retry under the same
approval.

**Pass criteria:** every stage completes; every LLM invocation is `VALID` (successful repairs
allowed); all blueprint citations resolve with origin "Qloo (live)"; `spend today` ≤ $0.50 and
agrees with the Console within rounding.

**Evidence (no secrets):** in the same private terminal, run
`node packages/db/dist/admin.mjs report project <projectId>` (the id is in the project URL). It
prints run states, per-call role/model/tokens/latency/estimated cost, Qloo call counts by method
and origin, ledger totals, evidence stances and blueprint traceability, with no prompts, outputs,
excerpts or Qloo payloads. Add `spend today`, the Console charge, and screenshots of the story page
kept out of the repository ([rights review](DATA_RIGHTS_REVIEW.md)). Save the report as
`docs/evidence/production-acceptance-<date>.json` with a short report. Keep it separate from the
local subscription results.

**Rollback:** `RUN_ACCESS=off`, budgets to `0`, remove `ANTHROPIC_API_KEY`, revoke grants. Stored
results stay readable. Restoring `northflank.env.example` returns the service to zero budget.

## 5. Public demo and judge access (after §4 passes)

- **Public read-only story (no spend).** On the blueprint page: **Share read-only → The whole
  story**, expiry **30 days** (covers judging, Nov 2–5, 2026). Copy the **Link ID** shown in the
  dialog, then `admin.mjs sample feature <Link ID>`. Visitors open it from **Demo samples**: brief,
  Qloo discovery, tested hypotheses, the blueprint and its evidence, with no workspace, code or model
  call. `sample unfeature` withdraws it.
- **Live generation for judges.** The rules ask for a functional demo judges can test, with
  credentials in the testing instructions if access is restricted. Issue one grant per judging
  session after reviewing the final run's real cost. Proposed: `--days 7 --runs 2 --usd 0.40`;
  raise the global/workspace/experiment caps to cover all active grants, for example $2.00 for
  five grants. Codes go only in Devpost's testing-instructions field. Set `RUN_ACCESS=invite`.
- During Nov 2–5, check `spend today` and the Console usage daily. Revoke on suspected disclosure.

## 6. Open owner decisions

1. Merge and deploy this branch; make port `p01` public (§2.1). Free.
2. Approve §3–§4: key, Console limit, one paid run of about $0.14 (≤ $0.50).
3. Send the organizer clarification in [DATA_RIGHTS_REVIEW.md](DATA_RIGHTS_REVIEW.md) (display
   of Qloo-derived names and gradings).
4. Choose judge access: read-only story only, or story plus capped live grants.
