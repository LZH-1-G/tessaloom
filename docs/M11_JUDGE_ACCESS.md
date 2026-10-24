# M11 judge access and Qloo demonstration

**Default launch preparation is read-only, keyless and zero-budget. It is not yet an adequate functional Qloo demo.** Keep `APP_ENV=production`, `QLOO_MODE=live`, `QLOO_RAW_RETENTION=off`, `RUN_ACCESS=off`, both global budgets zero and all provider files empty. Never change production to test/fixture/scripted mode to make synthetic samples appear.

## What can honestly be shown

| Capability                                                                               | Evidence now                                                                                                                                     | Judge-demo implication                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creative Brief, discovery, hypotheses, Evidence Graph, What-if, blueprints, share/export | Previous local synthetic journeys and PR #14 CI; M11 preserves the code.                                                                         | Local recordings/screenshots must retain **FIXTURE — not real Qloo data**. They do not prove a live public Qloo application.                                              |
| Live Qloo search, cross-domain rank/recommend, audience/geography behavior               | Historical Harness source/response investigation documented in [V1 validation](research/QLOO_V1_VALIDATION.md).                                  | Historical findings only; current key, quota, expiry, live compatibility and permissions are not reverified. Some categories/fields were missing or unsupported.          |
| DeepSeek structured generation and critique                                              | Two separately authorized calls using synthetic inputs on October 23; [measured results](DEEPSEEK_LIVE_TRIAL_2026-10-23.md).                     | Not a Qloo + DeepSeek E2E result, not renewed authorization, and not an account debit verification.                                                                       |
| Production saved samples                                                                 | Fixture listings are hidden and fixture payloads return 403. Nonfixture samples require appropriate display/retention permission and provenance. | Existing synthetic sample export must not be imported as a workaround. An empty sample list or 200 HTML shell is not acceptance.                                          |
| Real Qloo → claim evaluation → DeepSeek critique → blueprint                             | **UNVERIFIED / BLOCKED**.                                                                                                                        | Needs quota/expiry, permission for retention/public display and any transfer of Qloo-derived facts to DeepSeek, then explicit owner approval and bounded live acceptance. |

See [calibration status](LIVE_QLOO_CALIBRATION.md). Do not contact organizers in this task; the existing unsent questions remain a possible owner-controlled route. No new Qloo, DeepSeek or other paid calls are permitted by these documents.

## Proposed safe judge route, requiring later approval

1. First obtain a minimal approved real-data journey and permitted normalized public sample. Preserve original retrieval times, source pointers, LIVE/CACHE distinction, unknown/insufficient results, AI interpretation and creative speculation. A cache timestamp must not become a new retrieval date. Keep raw retention off. Public replay permission is separate from having a working API credential.
2. Make an approved nonfixture saved journey readable without a code, if allowed, so the main explanation works while paid work is paused. Validate its actual data endpoints and graph/blueprint views, not only page shells. State clearly that viewing saved results does not make a new live call.
3. If live judge generation is approved, issue a separate expiring grant per judge or judging session, with a finite total run allowance and USD ceiling. Propose initially **two runs / US$0.40 total per grant**; this is a safety ceiling to review, not a promise that it completes two journeys. Calibrate actual run costs before choosing the final allowance. Do not issue an unrestricted shared code. Codes go only into the approved private testing-instructions channel; never in URLs, README, analytics, screenshots or public sample text.
4. Enable `RUN_ACCESS=invite` only after account-side controls and a bounded live validation are approved. Keep global active runs at two and review the global daily allowance, workspace/experiment/per-run caps and total grant ceilings together. Global daily counters reset on **UTC** days; per-grant lifetime caps do not. Budget values must be explicit, not inherited shell defaults.
5. DeepSeek additionally requires `DEEPSEEK_LIVE_APPROVED=on`, nonzero bounded request/CNY settings, a worker-only key, and reviewed pricing/FX. The present adapter is a guarded trial (CNY budget at most 2, configured maximum requests at most 4; verify settings before activation). Pricing review expires after 24 hours. It is not an unattended multiweek live service. Do not automate review-date refresh or raise the trial bounds just to keep judging available. A broader supported live mode would need separate approval and implementation.
6. Use `spend today` and grant listing for operator checks; monitor provider account limits independently. Budget reservations precede dispatch and uncertain charges stay reserved. Application USD estimates are not a guaranteed provider invoice ceiling. Never clear unknown reservations or restore an old ledger to regain allowance.

The quota proposal is **not a hackathon-compliance certification**. The current rules' judge-access wording needs owner review, and a capped workflow must still let judges evaluate the features described. If the real-data demonstration or access terms cannot be satisfied, report a submission blocker; do not substitute fake Qloo provenance or remove limits.

The DeepSeek adapter's request counter is per provider instance and resets on worker restart; it is not a deployment-lifetime quota. Persistent grant/spend reservations remain essential. Qloo adapter-operation limits are also not a proven bound on wire-level HTTP usage: a Harness workflow can issue multiple requests. Confirm actual provider quota accounting before live access.

## Exact operator commands (after authorization)

Use the `dc` function and explicit private env file from [the runbook](M11_RUNBOOK.md). The `admin` Compose service runs on the internal network with only runtime DB credentials and the share-token pepper, as UID 10001; it never loads provider keys or starts a worker. Output at grant creation contains the new access code once: run from a private terminal with transcript recording off.

```sh
dc run --rm admin grant list
dc run --rm admin spend today
# Only after approving finite paid judge access; this does not itself enable generation:
dc run --rm admin grant create --label judge-1 --days 7 --runs 2 --usd 0.40
# Revoke using the actual ID returned by create/list:
dc run --rm admin grant revoke GRANT_UUID
```

Choose duration from the actual review window and renew only after reviewing remaining lifetime budget; creating a new grant creates a new allowance. Browser workspace cookies must remain private. The judge enters the code in the application's access-code UI; the server hashes it with the pepper and checks access, expiry, run count and spend on the server. A copied code shares its grant's total caps; it does not gain an unlimited budget.

Revoke on suspected disclosure. For immediate shutdown, stop the app (stopping only the proxy does not stop an in-flight worker), set access/budgets/DeepSeek approval back to off/zero, then recreate the app. Revocation affects subsequent admissions/reservations; it cannot retract a provider request already dispatched. Preserve the ledger and record the interruption. Saved permitted data stays readable after restart with generation off.

## Judge instructions to finish before submission

Supply the final approved HTTPS URL, steps to the actual permitted sample, its retrieval date/limitations, optional private access-code procedure, expected run latency and quota behavior, and how to view the graph, What-if and blueprint. Explain any unavailable geography/trends/unsupported fields honestly. No working public URL, grant or real-data sample is claimed by M11 local preparation.
