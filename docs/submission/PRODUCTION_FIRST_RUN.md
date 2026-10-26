# Production release and the final paid Claude acceptance (prepared, not executed)

**Status: ready for owner approval. Nothing here has been executed in production.** No API key has
been created, requested or configured, no production variable or port changed, and no paid call
made. Every step marked **OWNER** needs your explicit go-ahead. The paid Claude call is
deliberately the **last** step. Everything before it is free.

The local run on 2026-10-26 (live Qloo, Claude Sonnet 5.5 on the owner's subscription) proved the
application path ([report](../CLAUDE_SUBSCRIPTION_LOCAL_ACCEPTANCE.md)). Production repeats that
scenario once through the official Anthropic API under a $0.50 ceiling. Its result becomes the
public, read-only, real-data story sample.

## 0. Production as verified (read-only, 2026-10-26 ~10:45 UTC)

| Item | Observed (evidence) |
| --- | --- |
| Service | `default/tessaloom`, 1 instance, `nf-compute-20` (`northflank get service`) |
| Deployed commit | **`a37afc6`** (PR #19 merge), deployment `6adf02088a11dc200a3ad9ee`, build SUCCESS, deployment COMPLETED 07:33 UTC |
| Previous release (rollback) | `39c0fe5`, deployment `6aded5c0351e0f7052ed6dbd` |
| Worker | `worker_queue_connection` verified (`databaseCreate: false`, `schemaCreate: false`), `worker_queues_started` with `llm: "unconfigured"`, `qlooMode: "live"` |
| Qloo readiness | 39/39 probes 07:32–10:42 UTC: `ready: true`, `endpointTrusted: true`, Harness `0.1.26`, `probeFailure: null` |
| Private smoke via port-forward (`--skipHostnames`) | `deploy/public-smoke.mjs` read-only checks **7/7 pass**; `/api/health/ready` 200; status `llmConfigured: false`, `llmModel: null`; HSTS, nonce CSP, `X-Frame-Options: DENY`, nosniff, referrer and permissions policies present; static assets 200 with immutable caching |
| Public samples | **0** (`/api/v1/samples` → `{"items":[]}`) |
| Run access | **`invite`**, not off: `RUN_ACCESS` is unset in the web environment, and `runAccessFor` defaults production to `invite`. Runs still cannot start without a redeemed, active grant, and with no key a run would stop at R1 (`LLM_NOT_CONFIGURED`) before any Qloo call. Set `RUN_ACCESS=off` explicitly before exposure (§2.1 step 6) |
| Port `p01` (HTTP 3000) | **`public: false`** |

**Remaining blockers for a public demo:** making port `p01` public (§2.1 steps 6–8), and the paid
acceptance (§4), which creates the first real sample and allows judge access.

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
| `MAX_WORKING_RUNS` / `MAX_ACTIVE_RUNS_PER_WORKSPACE` | `1` / `1` | unchanged |
| `WORKSPACE_DAILY_RUNS` | `1` | **`2`**: exploration and blueprint composition are separate run admissions (with `1`, Compose is refused with `RUN_LIMIT`; tested) |
| `RUN_ACCESS` | unset (= `invite` in production) | `off`; `invite` only during §4 and judging |
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
   --runs 2 --usd 0.50`. Keep the code private. Set `RUN_ACCESS=invite` in the config group
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
7. Immediately: `grant revoke <id>`, `RUN_ACCESS=off` (same config group), `spend today`, and compare with the Console
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
| By **Oct 29** | §4 final acceptance passed and reviewed (the key must exist for codes to work). Create the 4 codes below with `--days 14` (valid until about Nov 12). Set `RUN_ACCESS=invite` and the caps below. In a fresh browser, **redeem one code** on the home page and confirm "Demo access active". Redemption starts no run and costs nothing. |
| By **Oct 30, 6 PM ET** | Put the codes, their expiry and the steps in Devpost's testing instructions. Recheck the public smoke and the sample. Submit before **11:45 PM ET**. |
| **Nov 2–5** (judging) | Daily: `spend today`, `grant list`, Console usage, `/api/health/ready`, Qloo readiness. Revoke and replace a code that spends abnormally (update Devpost if the form still allows edits; otherwise rely on the caps). |
| After judging | Revoke all codes, `RUN_ACCESS=off`, budgets `0`, remove the key. The read-only story sample can stay featured. |

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

1. ~~Merge and deploy~~ (done: production runs `a37afc6`). Make port `p01` public (§2.1, steps 6–8).
2. Approve §3–§4: dedicated key, Console limit, one paid acceptance (≈ $0.14, ≤ $0.50).
3. Send the organizer clarification in [DATA_RIGHTS_REVIEW.md](DATA_RIGHTS_REVIEW.md).
4. Approve §5.2 judge access, issued **by Oct 29** (before submission), with up to $4/day and $15 total at the Console limit.
5. Make the GitHub repository public; submit on Devpost before Oct 30, 11:45 PM ET.
