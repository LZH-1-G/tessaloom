# Public judge demo: deployment, verification, rollback

**Prepared 2026-10-27. Nothing here has been applied.** Production is closed today:
- `RUN_ACCESS=off`, no AI provider key, `llmConfigured:false`;
- every LLM budget is $0, and there are 0 samples.

A visitor can create a project and type a brief, but cannot run the agent.

## Why a labelled synthetic demo

Two Qloo permissions are unresolved, and the organizer has not replied in writing (see
[GEMINI_MIGRATION.md](../GEMINI_MIGRATION.md) §7):
- sending Qloo-derived data to an AI provider;
- publicly displaying Qloo-derived data.

**Silence is not permission.** The public site therefore runs the **same application** on a
**synthetic Qloo transport**: fictional titles, generated aggregate signals, every record
labelled "FIXTURE — not Qloo data". The live Qloo integration stays in the code, verified
locally on 2026-10-26 ([acceptance report](../CLAUDE_SUBSCRIPTION_LOCAL_ACCEPTANCE.md)).

| Mode | AI | Cost | Permission needed | Status |
| --- | --- | --- | --- | --- |
| **Demo A** ([group](../../deploy/northflank-groups/llm-limits.demo-synthetic.json)) | Scripted stand-ins; the banner says "Scripted AI demo: no language model is called" | **$0** | none | Ready. The full journey was verified locally in a browser. |
| **Demo B** ([group](../../deploy/northflank-groups/llm-limits.demo-gemini-flash.json)) | Real Gemini 3.8 Flash on synthetic data (the live-data gate stays off) | $0.044 per measured workflow; ≤ $1.00/day ledger cap | paid spend | Synthetic workflow passed 2026-10-27 ([evidence](../evidence/gemini-3.8-flash-e2e-2026-10-27.md)); deployment needs approval |

Both modes share the same mechanics:
- `APP_ENV=staging`: synthetic data is refused under `production`, while HTTPS, secure cookies
  and DB TLS stay on;
- `QLOO_MODE=synthetic`;
- `RUN_ACCESS=open`.

## What judges do (Demo A or B)

1. Open <https://p01--tessaloom--mpfcqkyl42yb.code.run>. The top banner says the data is
   fictional, and in Demo A that no language model is called.
2. **Start a new project** → name it → **Create project**.
3. **Use the fixture example** (a supper club mixing a cozy game, an illustrated travel book and
   a neon film), or type 2–6 interests of your own.
4. **Interpret brief** → **Confirm & discover**. If an interest is ambiguous, pick a candidate →
   **Open the Discovery canvas**: about 200 cross-world bridges and a scored collision pool.
5. **Generate hypotheses with this pool**. Open **Hypotheses**: each hypothesis has
   supports/contradicts counts, and **Inspect evidence** shows each claim, its deterministic
   grading rule, and a trace.
6. **Select** one or more hypotheses → **Compose blueprint** → a 10-block plan.
   - Each block is labelled evidence-backed, AI interpretation, or creative speculation.
   - Citations resolve to the evidence appendix.
   - Export Markdown/JSON, print, or share read-only.
7. Optional: **What-if** → change a weight or a seed → compare.

Each stage takes seconds in Demo A, and up to about a minute per stage in Demo B. No sign-up,
code or payment is needed. Limits: one active run per visitor workspace, 10 runs per workspace
per day, 4 working runs site-wide (otherwise "The studio is busy", with a retry).

## Deployment (each step needs the owner's approval)

**Step 0, code.**
1. Merge PR #26 into `main`, and wait for Northflank's build of the merge SHA.
2. Deploy it:
   `northflank update service deployment --project default --service tessaloom --quiet -o json --input '{"internal":{"id":"tessaloom","branch":"main","buildSHA":"<merge SHA>"},"docker":{"configType":"default"}}'`
3. Check: readiness 200 and `STATUS` unchanged (`llmConfigured:false`). The code is inert in the
   closed state.

**Step 1, switch to Demo A.** Order matters. The worker refuses scripted AI or synthetic data
under `APP_ENV=production`, so change the service environment **before** the group.

1. Northflank → service `tessaloom` → Environment. Edit **only** these two runtime variables:
   - `APP_ENV`: `production` → `staging`
   - `QLOO_MODE`: `live` → `synthetic`

   Never paste a whole runtime-env body: it replaces every variable.
2. Load the runbook shorthands ([OPERATOR_RUNBOOK.md](OPERATOR_RUNBOOK.md)), then run
   `LIMITS demo-synthetic`, then `ACCESS open`, then `RESTART`.
3. Wait for the deployment to show COMPLETED (about 90 s).

**Step 2, verify** (read-only, about 5 minutes):

| Check | Expected |
| --- | --- |
| `STATUS` | `"mode":"fixture","qlooTransport":"synthetic","llmConfigured":true,"llmModel":"scripted-demo"` |
| `SHOWENV` | `RUN_ACCESS=open`, every `*_LLM_USD=0`, `GLOBAL_DAILY_QLOO_CALLS=2000`, runs `4/1/10` |
| `node deploy/public-smoke.mjs https://p01--tessaloom--mpfcqkyl42yb.code.run` | pass. Do **not** add the write probe: it asserts that runs are refused. |
| A fresh private browser window, judge steps 1–6 | blueprint shown, banner visible, no console errors |
| `ADMIN "spend today"` | `globalLlmUsdToday: 0` |

**Demo B (optional, after Exp. B and E2E-B pass).**
1. Add `GEMINI_API_KEY` to the service's restricted runtime secrets.
2. Apply `LIMITS demo-gemini-flash`.
3. In the `tessaloom-llm-limits` group, set `GEMINI_PAID_TIER_APPROVED=on` and
   `GEMINI_PRICING_VERIFIED_AT=<your review time>`.
4. `RESTART`.
5. `STATUS` should report `llmModel:"gemini-3.8-flash"`. Run one journey yourself and check
   `ADMIN "spend today"`.

The ledger caps spend at **$1.00/day globally** and $0.50 per visitor workspace and per
experiment. A measured workflow costs $0.044 ([evidence](../evidence/gemini-3.8-flash-e2e-2026-10-27.md)),
so about 22 fit in one day. The worst case from Oct 27 to Nov 5 is $10. If a single code or abuse burns the day's budget, runs answer
"busy/paused" until the next UTC day.

## Rollback (any time; minutes)

1. `ACCESS off`. New runs stop immediately; saved work stays readable.
2. `LIMITS closed`. This returns to Anthropic-selected, keyless, $0, and must come **before**
   step 3.
3. Northflank Environment: `APP_ENV` → `production`, `QLOO_MODE` → `live`.
4. `RESTART`. `STATUS` should show `"mode":"live","llmConfigured":false`, the state recorded on
   2026-10-27.
5. **If Demo B ran:** remove `GEMINI_API_KEY` from the service, and revoke the key in Google AI
   Studio if it is no longer needed.
6. **Code regression:** re-pin `859cd9f` with the step 0 command, using
   `"buildSHA":"859cd9f6dee33b4c7faf252180c3d17edf32cc32"`.

Demo projects remain in the database, labelled `DEVELOPMENT_FIXTURE`. A production build
refuses to serve them (403), so they never appear as Qloo data.
