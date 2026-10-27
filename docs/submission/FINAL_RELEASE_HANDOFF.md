# Final release handoff — 2026-10-27

The single status record for the Qloo Agentic Hackathon release. Deadline **Oct 30, 2026,
11:45 PM ET** (Oct 31, 11:45 AM Beijing); judging **Nov 2–5**. Executable steps:
[OPERATOR_RUNBOOK.md](OPERATOR_RUNBOOK.md). Reasoning: [PRODUCTION_FIRST_RUN.md](PRODUCTION_FIRST_RUN.md).

Classes: **COMPLETED AND VERIFIED** · **BLOCKED BY EXTERNAL DEPENDENCY** · **REQUIRES USER
ACTION** · **NOT COMPLETED** (with reason).

## Production (read-only checks, 2026-10-27 ~01:30 UTC)

| Item | Class | Evidence |
| --- | --- | --- |
| Deployed revision | COMPLETED AND VERIFIED | **`859cd9f`** (PR #24 merge) since 2026-10-27 02:21 UTC, owner-approved manual rollout; `buildSHA` = `deployedSHA`. Rollback target `51be618`. Smoke 7/7, render checks pass, 390 px overflow 107 → 0 px, no paid or Qloo run calls ([rollout evidence](../evidence/rollout-859cd9f-2026-10-27.md)) |
| HTTPS, headers | COMPLETED AND VERIFIED | `deploy/public-smoke.mjs` 7/7; TLS verifies; HSTS `max-age=31536000; includeSubDomains`, nonce CSP, `X-Frame-Options: DENY`, nosniff, referrer and permissions policies |
| Database, worker, Qloo | COMPLETED AND VERIFIED | `/api/health/ready` 200; status `workerOnline:true`, `qlooReady:true`, Harness 0.1.26; logs since the restart: 151 Qloo readiness probes, all `ready:true`, 0 stderr or error-level lines |
| Run access and AI | COMPLETED AND VERIFIED | `RUN_ACCESS=off`; `tessaloom-llm-limits` closed set: Sonnet 5.5 only, every `*_LLM_USD` = 0, Qloo calls 0; 0 `ANTHROPIC*` names; status `llmConfigured:false`; `spend today` 0; 0 grants; 0 samples |
| Subscription cannot reach production | COMPLETED AND VERIFIED | Env schema refuses it outside development/test (unit tests); `CLAUDE_SUBSCRIPTION_LOCAL_APPROVED=off`; the Agent SDK is absent from the image (`/app/node_modules/@anthropic-ai` does not exist) |
| No admin surface | COMPLETED AND VERIFIED | Public smoke: admin-like paths 404; the admin CLI runs only through `northflank exec` with team credentials |
| Desktop and mobile rendering | COMPLETED AND VERIFIED | `deploy/public-render-check.mjs`: Chromium + WebKit × 1440 / 390 → 200, overflow 0, CSP violations 0, workspace call blocked (no record) |

## Code and product quality

| Item | Class | Evidence |
| --- | --- | --- |
| Full local test run | COMPLETED AND VERIFIED | 2026-10-27, branch `claude/final-release-pass`: lint, typecheck, unit **469/469**, integration **96/96** (PostgreSQL), runtime **16/16**, E2E **34/34** (Chromium + WebKit, fixture data, scripted AI, axe checks), invite journey **2/2**, read-only samples **2/2** |
| Mobile overflow on project pages (bug) | COMPLETED AND VERIFIED (not deployed) | Found on the saved real run: every project page scrolled sideways at 390 px (107 px). Causes: (1) the step rail's grid cell kept `min-width: auto`, so the single column grew to the rail's width; (2) locked steps' absolutely positioned sr-only notes escaped the non-positioned scroller (+29 px). Fix: `min-w-0` on the nav and `relative` on the rail (`apps/web/src/components/app-shell.tsx`). Regression test `e2e/mobile-layout.spec.ts` failed with 107, then 29, and passes after both fixes. **Production still has the bug until an approved rollout** |
| Export sanitization on real data | COMPLETED AND VERIFIED | Owner Markdown/JSON export of the real blueprint: no uppercase Qloo-style IDs, no popularity/affinity values ("affinity" appears only in disclaimer wording). Shared exports strip internal IDs (integration test) |
| Real-data pages | COMPLETED AND VERIFIED | 9 pages × Chromium/WebKit × desktop/phone on the saved run: all 200, no console errors, no Qloo IDs in page text (pointer values appear only inside the evidence drawer/trace, as disclosed) |
| Paid entry points gated | COMPLETED AND VERIFIED | Run start, retry, What-if branch, compose and section recompose all pass run admission (code); comparisons are template-only. Cost tests: reservations before every attempt, retries, revocation, expiry, kill switch, run limits (`m10a-cost-safety`, `spend-retries`) |

## Judge access (no production writes)

| Item | Class | Evidence |
| --- | --- | --- |
| Four-code rehearsal | COMPLETED AND VERIFIED | Scratch local DB, real admin CLI: 4 × `--days 14 --runs 6 --usd 1.00` (expiry +14 days, 6 runs, $1). Local invite server + scripted worker: anonymous start `403 RUN_ACCESS_REQUIRED`; redeemed code start `202`; second concurrent start `429 RUN_LIMIT`; other workspace `404`; no CSRF header `403`; revoked and expired codes the same `400`; `grant list`, `spend today` and `report project` correct (report has no prompt or output text). Scratch DB dropped, codes deleted |
| Production admin CLI | COMPLETED AND VERIFIED | `northflank exec … node packages/db/dist/admin.mjs spend today / grant list / sample list` → 0 / 0 / `[]` (read-only) |
| Operator runbook shorthands | COMPLETED AND VERIFIED | `SHOWENV`, `ADMIN "spend today"`, `STATUS` run in zsh against production; `LIMITS` payloads dry-run for all three sets |
| Production codes | REQUIRES USER ACTION | Created only after the paid acceptance passes and with approval (runbook F) |

## Security and repository

| Item | Class | Evidence |
| --- | --- | --- |
| Full-history secret scan | COMPLETED AND VERIFIED | gitleaks 8.30.0, all refs, offline: 76 commits, no leaks. Working-tree hits are the documented test sentinels allowlisted in `.gitleaks.toml`, and git-ignored `.next` build output |
| Dependency vulnerabilities | COMPLETED AND VERIFIED | osv-scanner 2.3.0 on `pnpm-lock.yaml`: 621 packages, no issues |
| Licenses | COMPLETED AND VERIFIED | 2026-10-26 inventory: permissive except sharp's LGPL libvips binary (not vendored) and the local-only Agent SDK ([PUBLIC_READINESS.md](PUBLIC_READINESS.md)) |
| Privacy | COMPLETED AND VERIFIED | No absolute local paths in tracked files; the only emails are placeholders, test strings and Qloo's published security contact |
| Stale incident guidance | COMPLETED AND VERIFIED | `docs/SECURITY.md` named a nonexistent `LIVE_RUNS_ENABLED` flag; now `RUN_ACCESS=off` |
| Repository settings | COMPLETED AND VERIFIED | Public; MIT detected; secret scanning and push protection on |

## Submission materials

| Item | Class | Evidence |
| --- | --- | --- |
| Devpost text | COMPLETED AND VERIFIED | [DEVPOST.md](DEVPOST.md): all sections, pitch, captions, video description, troubleshooting; every quoted UI label checked against the code. Open: `[RUN_DATE]`, `[PRODUCTION_RESULT]`, `[JUDGE_CODE_1–4]`, `[CODE_EXPIRY]` |
| Gallery | COMPLETED AND VERIFIED | Five real-data screenshots, Qloo IDs redacted, captions; delivered to the owner, not committed |
| Demo video | COMPLETED AND VERIFIED | `tessaloom-demo.mp4` (1:43, narrated, subtitled) and `tessaloom-mobile-story.mp4` (0:27) from the saved run, no new calls; tracks and frames checked ([DEMO_SCRIPT.md](DEMO_SCRIPT.md)); delivered, not committed |
| Rules re-check | BLOCKED BY EXTERNAL DEPENDENCY | `qloo.devpost.com/rules` returned a Cloudflare bot check on 2026-10-27; deadline and requirements rest on the 2026-10-26 reading |
| Devpost draft entry | REQUIRES USER ACTION | Needs the owner's Devpost login; not attempted |
| Qloo display question | BLOCKED BY EXTERNAL DEPENDENCY | Posted by the owner on the Devpost forum 2026-10-26; **reply pending**. Its answer table is in [QLOO_PERMISSION_REQUEST.md](QLOO_PERMISSION_REQUEST.md) |
| Publishing real-data media | BLOCKED BY EXTERNAL DEPENDENCY | Screenshots and videos show Qloo-derived names; public upload waits for the reply or the owner's informed decision |

## Paid acceptance and judging

| Item | Class | Evidence |
| --- | --- | --- |
| Anthropic workspace, $15 limit, key in `tessaloom-anthropic` | REQUIRES USER ACTION | Runbook A |
| Single paid acceptance (≈ $0.14, ≤ $0.50 application cap) | REQUIRES USER ACTION | Runbook B–D after explicit approval. Application accounting is an estimate, not a provider guarantee; the Console limit is the backstop |
| Story sample, judge codes, `RUN_ACCESS=invite` | REQUIRES USER ACTION | Runbook E–F, by Oct 29 |
| Deploy the mobile-layout fix | COMPLETED AND VERIFIED | Rolled out 2026-10-27 02:21 UTC ([rollout evidence](../evidence/rollout-859cd9f-2026-10-27.md)); rollback target `51be618` |

## Rollback

See the table at the end of [OPERATOR_RUNBOOK.md](OPERATOR_RUNBOOK.md). In short: `RUN_ACCESS=off`
stops new runs at once; `LIMITS closed` zeroes every budget; grants revoke immediately; the key
can be revoked in the Console; build `51be618` can be re-pinned (the command is in the rollout
evidence).
