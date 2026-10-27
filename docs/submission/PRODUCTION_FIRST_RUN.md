# Production release and the final paid Claude acceptance

**Status (2026-10-26): release, exposure and the zero-budget limits (§2.2) done; paid steps
prepared, not executed.** Production serves `859cd9f` on a public URL with `RUN_ACCESS=off` and
every LLM/Qloo budget pinned to `0`. No Anthropic key exists for this project, and no paid call
has been made. Every step marked **OWNER** needs your explicit go-ahead. The paid
Claude call is deliberately the **last** step.

The local run on 2026-10-26 (live Qloo, Claude Sonnet 5.5 on the owner's subscription) proved the
application path ([report](../CLAUDE_SUBSCRIPTION_LOCAL_ACCEPTANCE.md)). Production repeats that
scenario once through the official Anthropic API under a $0.50 ceiling. Its result becomes the
public, read-only, real-data story sample.

## 0. Production as verified (read-only, 2026-10-26)

| Item | Observed (evidence) |
| --- | --- |
| Service | `default/tessaloom`, 1 instance, `nf-compute-20` |
| Deployed commit | **`859cd9f`** (PR #24 merge), manual rollout 2026-10-27 02:21 UTC, `deployedSHA` = `buildSHA` ([evidence](../evidence/rollout-859cd9f-2026-10-27.md)). Before: `51be618` (PR #22), 2026-10-26 12:22 UTC |
| Previous releases (rollback) | `51be618` (PR #22, first choice), `a37afc6` (PR #19), and `39c0fe5`, deployment `6aded5c0351e0f7052ed6dbd` |
| Worker | `worker_queue_connection` verified (`databaseCreate: false`), `worker_queues_started` with `llm: "unconfigured"`, `qlooMode: "live"` |
| Qloo readiness | `ready: true`, `endpointTrusted: true`, Harness `0.1.26` |
| Public URL | **https://p01--tessaloom--mpfcqkyl42yb.code.run**, port `p01` public since ~12:24 UTC; public smoke 7/7 and Chromium/WebKit desktop/mobile checks pass |
| Run access | **`off`**, from config group `tessaloom-run-access` (`printenv RUN_ACCESS` → `off`) |
| LLM and budget variables (before §2.2) | **All unset** (`printenv`, 2026-10-26): `LLM_PROVIDER`, `LLM_MODEL`, `LLM_FALLBACK_MODEL`, `LLM_MODE`, every `*_LLM_USD`, `GLOBAL_DAILY_QLOO_CALLS`, `MAX_WORKING_RUNS`, `MAX_ACTIVE_RUNS_PER_WORKSPACE`, `WORKSPACE_DAILY_RUNS`. 0 variables named `ANTHROPIC*`/`CLAUDE_CODE*`. The code defaults therefore apply (next row) |
| Code defaults that would apply | `LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-opus-5-5`, `GLOBAL_DAILY_LLM_USD=15`, `WORKSPACE_DAILY_LLM_USD=3`, `EXPERIMENT_LLM_USD=5`, `GLOBAL_DAILY_QLOO_CALLS=300`, `MAX_WORKING_RUNS=6`, `MAX_ACTIVE_RUNS_PER_WORKSPACE=3`, `WORKSPACE_DAILY_RUNS=20` (`packages/config/env.ts`). Harmless while no key exists and run access is off, but **adding a key before the limits group (§2.2) would run Opus under $15/day caps** |
| Limits group (§2.2) | **Applied 2026-10-26 12:54 UTC**: `tessaloom-llm-limits` (config, `tessaloom` only) = `llm-limits.closed.json`; restart completed 12:55 UTC on the same deployment (`51be618`). `printenv`: Sonnet 5.5 only, every `*_LLM_USD` = `0`, `GLOBAL_DAILY_QLOO_CALLS=0`, runs 1/1/1, `RUN_ACCESS=off`, 0 `ANTHROPIC*` names. `child_start`: the worker received the LLM/budget names, the web the run limits. New instance: Qloo `ready: true`, `llm: "unconfigured"`, 0 error lines; public smoke 7/7. The Qloo readiness probe does not use the daily quota, so `0` calls leaves it working |
| Public samples | **0** |

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

### 2.1 Release, verify privately, then expose (exact sequence)

**Merging is deploying.** Northflank CI is enabled on `main` (`disabledCI: false`), so merging PR #19
builds and deploys it automatically. The readiness probe gates traffic, but the port is private
anyway. Rollback target: commit **`39c0fe5`**, deployment **`6aded5c0351e0f7052ed6dbd`**
(2026-10-26 04:23 UTC).

Steps 1–4 were completed on 2026-10-26: PR #19 merged as `a37afc6` with CI fully green on
`main`, it was auto-deployed, and the private smoke passed (§0). Keep them for future releases.

1. **Gate.** PR #19's latest head is fully green in CI, including `docker` and `e2e`.
2. **Record the rollback target.** In Northflank → `tessaloom` → Deployments, note that
   `6aded5c0…` serves `39c0fe5`. Do not delete old builds.
3. **Merge** PR #19 with a merge commit, not a squash, so it can be reverted with
   `git revert -m 1`. Wait for build SUCCESS and deployment COMPLETED, then confirm the new SHA.
4. **Private smoke, port still private.** From your machine:
   `northflank forward service --project default --service tessaloom`, then, in another terminal,
   `node deploy/public-smoke.mjs http://<forwarded-host:port> --local`. All read-only checks must
   pass, including `llmConfigured: false`. Check the logs for `worker_qloo_readiness ready=true`
   and no errors. Stop the forward (`northflank forward cleanup-hosts` if it edited hosts).
5. **Rollback if any check fails.** Revert the merge commit on `main`
   (`git revert -m 1 <merge-sha>`, then push). CI rebuilds a tree identical to `39c0fe5` and
   deploys it. A faster path is redeploying deployment `6aded5c…` from the Northflank UI.
   Stored data is unaffected; this release has no migrations.
6. **Expose.** First set `RUN_ACCESS=off` in the service's runtime variables. It is unset today,
   which production treats as `invite`. After the restart, confirm without creating any record:
   the web `child_start` log line lists `RUN_ACCESS` among its `envNames`, and the runtime
   variable reads `off` in Northflank. Loading the studio in a browser would create an anonymous
   workspace. Then Northflank → Networking → port `p01` (HTTP 3000) → **Public**, with the
   Northflank-managed `code.run` domain and TLS. Keep `TRUSTED_PROXY_HOPS=0`.
7. **Public smoke (no production records).** From an outside network:
   `node deploy/public-smoke.mjs https://p01--tessaloom--mpfcqkyl42yb.code.run` (read-only: headers,
   readiness, status, samples, 404s, 401 without a workspace, CSRF refusal), then
   `node deploy/public-render-check.mjs https://p01--tessaloom--mpfcqkyl42yb.code.run <dir>`
   (Chromium + WebKit, desktop and mobile; workspace/project calls blocked, so nothing is
   written). `--write-probe` creates one anonymous workspace/project/brief; run it only if the
   owner accepts that record.
8. **Un-expose immediately** (port back to private) if the public smoke fails. Then fix or
   roll back as in step 5.

Known residual risk once public: with `TRUSTED_PROXY_HOPS=0`, every visitor shares one
rate-limit bucket (workspace creation 20/min, sample reads 60/min, share lookups 30/min, run
starts 20/min). That's safe for cost and fine for judges, but one aggressive client could
briefly throttle others. Raising it to `1` needs proof that Northflank's edge overwrites
`X-Forwarded-For`; that's a post-exposure check, not a release blocker.

### 2.2 Pin the limits first, without a key (OWNER approves; free)

Production sets none of the model or budget variables (§0), so this step must come **before**
any key exists. Use a second config group, like `tessaloom-run-access`: it touches no existing
variable, and deleting it is a clean rollback. Never edit the service's runtime environment
through the API with a partial body: that endpoint replaces every variable.

Prepared payloads (validated against the real env schemas by
`tests/unit/northflank-groups.test.ts`):

| File | When | LLM $ global / workspace / experiment | Qloo calls/day | Working runs / active per workspace / runs per workspace per day |
| --- | --- | --- | --- | --- |
| [`llm-limits.closed.json`](../../deploy/northflank-groups/llm-limits.closed.json) | Before the key; after judging | 0 / 0 / 0 | 0 | 1 / 1 / 1 |
| [`llm-limits.acceptance.json`](../../deploy/northflank-groups/llm-limits.acceptance.json) | §4, one paid run | 0.50 / 0.50 / 0.50 | 60 | 1 / 1 / 2 |
| [`llm-limits.judging.json`](../../deploy/northflank-groups/llm-limits.judging.json) | §5.2, Oct 29 – Nov 5 | 4.00 / 1.00 / 1.00 | 400 | 2 / 1 / 6 |

All three pin `LLM_PROVIDER=anthropic`, `LLM_MODEL` = `LLM_FALLBACK_MODEL` = `claude-sonnet-5-5`,
`LLM_MODE=standard`, and turn subscription, DeepSeek and Gemini off explicitly. None holds a
secret or `RUN_ACCESS`.

1. **Done 2026-10-26.** Create the group with zero budgets:
   `northflank create secret --project default --input "$(cat deploy/northflank-groups/llm-limits.closed.json)"`.
2. **Done 2026-10-26.** Restart the service (Northflank → `tessaloom` → Restart, or `northflank restart service --project default --service tessaloom`), then verify without printing any
   secret: `northflank exec service --project default --service tessaloom --cmd "sh -c 'printenv LLM_MODEL GLOBAL_DAILY_LLM_USD RUN_ACCESS'"`
   → `claude-sonnet-5-5`, `0`, `off`. Status stays `llmConfigured: false`.
3. To switch sets later, replace the group's variables (it holds only these, so a full
   replacement is safe):
   `node -e 'const g=require("./deploy/northflank-groups/llm-limits.acceptance.json");console.log(JSON.stringify({secrets:g.secrets}))' > /tmp/limits.json`,
   then `northflank update secret --project default --secretId tessaloom-llm-limits --input "$(cat /tmp/limits.json)"`,
   restart, and verify as in step 2.

Keep `SESSION_SECRET` and `SHARE_TOKEN_PEPPER` unchanged; changing the pepper invalidates grants
and shares. [`northflank.anthropic.env.example`](../../deploy/northflank.anthropic.env.example) shows
the same values as a whole environment for reference; do not apply it as a runtime-env body.

> **Executable steps:** [OPERATOR_RUNBOOK.md](OPERATOR_RUNBOOK.md) holds the exact commands,
> expected outputs, stop conditions and rollback for §3–§5, tested read-only against production
> on 2026-10-27. This file keeps the reasoning; where the two differ, the operator runbook wins.

## 3. Anthropic Console and key (OWNER, only when approving the final step)

Precondition: §2.2 done, `printenv GLOBAL_DAILY_LLM_USD` → `0`.

1. In the [Claude Console](https://console.anthropic.com), create a **dedicated workspace**
   `tessaloom` and one API key in it. The key is never pasted into chat, the repo, build
   arguments, logs, or a secret group that other services can read.
2. Set that workspace's **spend limit to $15/month** (Settings → Limits). It is the provider-side
   ceiling above every application cap ($0.50 for §4, $4/day during judging). The application
   ledger estimates cost; the Console limit is the independent guarantee.
3. In Northflank → Secret groups → **Create**, type **Secret**, name `tessaloom-anthropic`,
   restricted to the `tessaloom` service only, one variable `ANTHROPIC_API_KEY`. Paste the key
   only in that UI field. Restart.
4. Verify with zero spend: status `llmConfigured: true` and `llmModel: "claude-sonnet-5-5"`
   (`curl -s https://p01--tessaloom--mpfcqkyl42yb.code.run/api/v1/system/status`). Budgets are
   still `0` and `RUN_ACCESS` is still `off`, so nothing can spend yet.

## 4. Final paid acceptance (OWNER approves; run once, last)

### Go / no-go gate (all must be true before step 1)

- [x] §2.2 limits group exists with the closed set (verified 2026-10-26).
- [ ] Console workspace `tessaloom` exists with a **$15/month** spend limit (owner).
- [ ] Secret group `tessaloom-anthropic` (secret, `tessaloom` only) holds the key; after restart,
      status `llmConfigured: true`, `llmModel: "claude-sonnet-5-5"`, and `printenv
      GLOBAL_DAILY_LLM_USD` → `0` (§3 step 4).
- [ ] Public smoke 7/7 and Qloo `ready: true` on the same day.
- [ ] The owner's explicit written approval for **this one run** in chat, quoted in the evidence.

Any unchecked box means no-go. Nothing in §4 runs without all five.

### The $0.50 guard, layer by layer

1. **Spend ledger (M10-A).** Before every attempt (first try, repair, truncation retry) the worker
   reserves the call's upper bound against the global-daily, workspace-daily and experiment caps
   ($0.50 each) and the grant cap ($0.50). If it does not fit, the call is never sent. Unknown
   outcomes keep the full reservation.
2. **Grant:** `--days 1 --runs 2 --usd 0.50`: two run admissions (exploration + composition) for one workflow, one $0.50 cap, revocable at once.
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
   --runs 2 --usd 0.50`. Keep the code private. Switch `tessaloom-llm-limits` to
   `llm-limits.acceptance.json` (§2.2 step 3). Set `RUN_ACCESS=invite` in the config group
   `tessaloom-run-access` (it holds only this variable, so replacing its contents is safe:
   `northflank update secret --project default --secretId tessaloom-run-access` with
   `{"secrets":{"variables":{"RUN_ACCESS":"invite"}}}`). Restart the service, then check
   `printenv RUN_ACCESS` with `northflank exec`. Never edit the service's own runtime environment
   with a partial body: that endpoint replaces every variable.
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
7. Immediately: `grant revoke <id>`, `RUN_ACCESS=off` (same config group), switch the limits
   back to `llm-limits.closed.json`, restart, then `spend today` and compare with the Console
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

**Rollback:** `RUN_ACCESS=off` (config group), limits back to `llm-limits.closed.json`, revoke
grants (`admin.mjs grant revoke <id>`), and delete the `tessaloom-anthropic` group (or revoke the
key in the Console, which takes effect even if Northflank is unreachable). Restart. Stored results
stay readable.

## 5. Public demo and judge access (after §4 passes)

### 5.1 Read-only story (no spend)

On the blueprint page: **Share read-only → The whole story**, expiry **30 days**. Copy the
**Link ID** from the dialog, then run `admin.mjs sample feature <Link ID>`. Visitors open it from
**Demo samples**: brief, Qloo discovery, tested hypotheses, the blueprint and its evidence, with
no workspace, code or model call. `sample unfeature` withdraws it. Production has **0 samples**
today, so this sample only exists after §4.

### 5.2 Interactive judge access, Nov 2–5, 2026 (required by the rules)

The rules require a functional demo that judges can test, with credentials in the testing
instructions if access is restricted. The read-only story alone is **not** enough. The codes and
testing instructions must be **ready and working before the submission deadline (Oct 30, 11:45 PM
ET)** and stay valid **through Nov 5** with margin.

**Schedule**

| When | Action |
| --- | --- |
| By **Oct 29** | §4 final acceptance passed and reviewed (the key must exist for codes to work). Create the 4 codes below with `--days 14` (valid until about Nov 12). Switch `tessaloom-llm-limits` to `llm-limits.judging.json` (§2.2 step 3), set `RUN_ACCESS=invite`, restart, and verify with `printenv`. In a fresh browser, **redeem one code** on the home page and confirm "Demo access active". Redemption starts no run and costs nothing. |
| By **Oct 30, 6 PM ET** | Put the codes, their expiry and the steps in Devpost's testing instructions. Recheck the public smoke and the sample. Submit before **11:45 PM ET**. |
| **Nov 2–5** (judging) | Daily: `spend today`, `grant list`, Console usage, `/api/health/ready`, Qloo readiness. Revoke and replace a code that spends abnormally (update Devpost if the form still allows edits; otherwise rely on the caps). |
| After judging | Revoke all codes, `RUN_ACCESS=off`, limits back to `llm-limits.closed.json`, delete `tessaloom-anthropic` and revoke the key in the Console. The read-only story sample can stay featured. |

| Setting | Value | Why |
| --- | --- | --- |
| Grants | **4 codes** (`judge-1` … `judge-4`): `--days 14 --runs 6 --usd 1.00`, created by Oct 29 | 6 runs = 3 full workflows (exploration + composition each), ~$0.14 each at measured tokens. 14 days from Oct 29 covers submission, judging (Nov 2–5) and delays. Each code is capped for its whole lifetime, and a copied code shares that cap |
| `RUN_ACCESS` | `invite` | Anonymous visitors can read samples but cannot start runs |
| `GLOBAL_DAILY_LLM_USD` / `WORKSPACE_DAILY_LLM_USD` / `EXPERIMENT_LLM_USD` | `4.00` / `1.00` / `1.00` | All four grants fit in one UTC day; one experiment cannot exceed a grant |
| `WORKSPACE_DAILY_RUNS` / `MAX_ACTIVE_RUNS_PER_WORKSPACE` | `6` / `1` | Matches the grant; one active run per judge |
| `MAX_WORKING_RUNS` | `2` | Two judges can run at once (runs paused at confirmation gates don't count); others see "The studio is busy" |
| `GLOBAL_DAILY_QLOO_CALLS` | `400` | About 10 explorations per day at ≤ 40 calls each, within Qloo's per-key quota (the hackathon guide says limits are raised on request) |
| Anthropic Console | workspace spend limit **$15/month** | Independent ceiling above all grants together ($4) |

The codes go only in Devpost's testing-instructions field. Assume that text may be seen beyond
the judges: each code is capped, revocable and expires. Check `spend today`, `grant list` and
the Console every day of judging. Revoke any code that is spending abnormally. After Nov 5:
revoke all grants, set `RUN_ACCESS=off` and budgets to `0`, and remove the key once judging is
confirmed finished.

## 6. Open owner decisions

1. ~~Merge, deploy, expose~~ (done: `51be618` public since 2026-10-26 ~12:24 UTC). ~~Make the
   repository public~~ (done 2026-10-26).
2. Send the organizer question ([QLOO_PERMISSION_REQUEST.md](QLOO_PERMISSION_REQUEST.md)).
3. ~~Approve §2.2~~ (done 2026-10-26). Approve §3 (dedicated key, $15 Console limit).
4. Approve §4: one paid acceptance (≈ $0.14, ≤ $0.50), **by Oct 29**.
5. Approve §5.2 judge access, issued **by Oct 29** (before submission): 4 codes, $4/day app cap,
   $15 Console limit.
6. Fill the Devpost placeholders and approve submission before Oct 30, 11:45 PM ET.
