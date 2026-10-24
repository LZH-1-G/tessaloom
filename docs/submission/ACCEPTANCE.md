# Submission-readiness acceptance — 2026-10-24

**The complete local interactive demonstration is usable and verified. Public submission is not yet complete.** The production fixture firewall is preserved, so prepared synthetic samples are not silently exposed as a working production demo.

Starting branch: `codex/live-provider-validation`; starting checkpoint: `d3ac49aa93e286b43d2bb0c9e17180843869eba1`, descending from the DeepSeek checkpoint and merged M10-B protections. No reset, merge, push, visibility change, live provider call or public deployment was performed. The final checkpoint SHA is reported in the task response; this report belongs to that checkpoint.

## Implemented and preserved

- Creative Brief with a one-click, explicitly fictional Harbor Lights example; intent confirmation, cultural discovery and collision-pool review.
- Persistent hypothesis loop with typed claims, deterministic evidence grading, inspectable Evidence Graph and request/fact traces.
- Dependency-aware What-if: seed changes recompute dependent queries; weights-only changes reuse evidence. Original retrieval dates remain distinct from reuse dates.
- Editable experience blueprints, evidence/interpretation/speculation/user-edit labels, append-only revisions, Markdown export, read-only sharing and revocation.
- Cancellation, partial outcomes, restart/recovery, separate web/worker identities, private mounted secrets, invitation access and global spending controls.
- Existing DeepSeek, Anthropic, Gemini and scripted adapters; no new provider requests. Deployment files now support a private worker-only DeepSeek key with all activation/budget gates off by default.

## Changes in this checkpoint

1. Replaced the stale M0 README with working setup, current architecture, judge instructions, evidence limitations and release links. Local defaults use the generated synthetic transport, scripted AI, loopback binding and zero paid-provider budgets.
2. Added the Harbor Lights example without auto-running work or overwriting a saved brief. Unified visible page/export banners as **FIXTURE — not real Qloo data** and removed unconditional live-Qloo claims from the dashboard introduction.
3. Added safe local sample preparation through the existing worker pipeline: one parent experiment, one weights-only branch, a blueprint and two featured read-only samples. It refuses nonlocal/populated databases and API-key-bearing environments; HTTP is disabled.
4. Fixed a genuine project-share projection defect: overview payloads had lost the fixture marker when detailed evidence was omitted. They now retain it, sample cards display it, and production listings hide fixture samples that the existing read firewall would reject. Production payload requests remain 403; no exception was added.
5. Added sample provenance/production-denial regression, actual prepared-sample browser checks, mobile overflow/accessibility checks, and a continuous default-example journey through graph, What-if, blueprint and sharing.
6. Pinned transitive `body-parser` to **2.4.0** for GHSA-27r3-jxmh-p828. The final production dependency audit reports no advisories.
7. Prepared English Devpost text, judge walkthrough, selected labelled screenshots, hosting comparison, deployment runbook updates and a dependency-license/public-readiness audit.

## Executed verification

| Check                                                                | Result and scope                                                                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full unit suite after dependency patch                               | **387 passed**, 25 files                                                                                                                            |
| Full database integration suite from preceding provenance checkpoint | **81 passed**, 14 files; unchanged domains reused rather than rerun without cause                                                                   |
| Affected blueprint integration                                       | **2 passed**, updated export label                                                                                                                  |
| Final sample/share/cost integration                                  | **24 passed**, including the new projection/production-denial test; overlaps the earlier full suite, not 24 additional independent cases            |
| Complete Chromium + WebKit journeys                                  | **28 passed**; includes default example → collision pool → hypotheses → graph → reload → What-if → blueprint → shared view/revoke and mobile checks |
| Invitation access browser checks                                     | **2 passed**, real local HTTP/DB/worker, synthetic providers                                                                                        |
| Actual prepared read-only sample browser checks                      | **2 passed**, both browsers; desktop + 390px mobile, serious/critical axe findings zero, no horizontal page overflow, no new runs/reservations      |
| Runtime boot/security suite                                          | **12 passed**; localhost listen needed normal approval after sandbox EPERM                                                                          |
| Build/static/schema                                                  | Production web/worker/DB build, root/script/web/worker type checks, ESLint and Drizzle migration check passed                                       |
| Browser bundle credential scan                                       | **670 files**, passed                                                                                                                               |
| Docker                                                               | ARM64 image built with the pinned container toolchain; full container lifecycle and M10-B checks passed as detailed below                           |
| Dependency audit                                                     | **0 vulnerabilities** after patch; 246 reported production/optional dependencies                                                                    |
| Full Git history secrets                                             | **28 existing commits scanned, no leaks**; working changes separately scanned before commit                                                         |
| License inventory                                                    | **485 installed package manifests**, including development/host-specific packages; no unknown declared license. This is not a container SBOM.       |

Browser, container and database results are local evidence. No remote CI/CodeQL, AMD64 runtime, cloud firewall, public TLS/URL or public uptime acceptance is claimed. Host checks used Node 26.11.1 and pnpm 11.25.0; the Docker build used its Node 22 / pnpm 10.34.7 configuration and frozen lockfile, matching the repository's package-manager pin. The exact `.nvmrc` patch version was not the host runtime.

The full deployment smoke passed mounted-secret denial under actual child UIDs, Qloo/Anthropic/DeepSeek sentinel delivery only to the worker, HTTPS/security headers, invite denial, zero reservations, backup/restore, database outage recovery, proxy-log redaction and observed PID 1 restart. The container smoke additionally passed the fixture pipeline, supervised Harness/PATH, log redaction, worker restart, readiness recovery, shutdown and production fixture/root-identity rejection. The final sample-focused production smoke verifies that imported synthetic samples are **denied**, not that a fixture public demo is enabled. Image identity and final smoke summaries are stored in `verification.json`. Full browser/M10-B suites passed earlier in this work; the dependency patch was rebuilt and container-tested, and the subsequent sample projection fix received targeted integration, both-browser and production security/denial checks. Unaffected lengthy suites were not repeated.

## Failures investigated, not hidden

- The interrupted browser run completed successfully; it was not restarted wholesale.
- Runtime checks first hit sandbox `listen EPERM`; they passed through the normal approval path, with no security bypass.
- The approval service temporarily could not review the history scan due to a usage limit. No rejected command ran; the scan later passed through normal approval.
- Production sample validation initially expected 200 but received 403. Source inspection confirmed the existing intentional fixture read firewall; the test now verifies denial. Local browser validation then exposed a missing project-overview fixture marker, which was fixed and regression-tested.
- Dependency audit found one high-severity parser advisory, now patched. The initial CI-mode installation required explicitly allowing the intended lockfile update; no broad dependency upgrade was made.
- `pnpm licenses list` initially lacked an installed package index. The documented read-only manifest inventory was used, without claiming a complete binary-license audit.
- Existing pg client-concurrency deprecation warnings are non-fatal; they are not a claim of future pg 9 compatibility.

## Real-provider evidence

Historical Qloo V1 capability checks are preserved in their dated report. No fresh event quota, expiry or current credential validity was verified. Raw Qloo retention remains off, and no real Qloo material was sent to DeepSeek.

Exactly two earlier synthetic-input `deepseek-v4-pro` requests passed strict JSON/schema and frozen semantic checks, with zero retries/fallbacks. The trial report records 7,990 total tokens and a token/tariff-derived CNY 0.075879 estimate; actual account debit was not independently supplied. This preparation added **zero** DeepSeek or Qloo calls. Real Qloo + DeepSeek E2E remains unverified, and these results do not validate every agent role or general cultural quality.

## Remaining issues and owner actions

| Priority                              | Issue / action                                                                                     | Why it remains                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**                                | Approve and establish a working public demo URL and content mode                                   | No public deployment is authorized. Current production rejects synthetic data reads; local samples are not a public demo. Use authorized nonfixture content under the unchanged production guard. Keep synthetic walkthroughs local or in clearly labelled supporting recordings; they do not replace the required working public demo. |
| **P0**                                | Approve repository push/publication after reviewing historical provider-derived material           | The repository has not been pushed or made public. MIT source licensing does not establish Qloo data redistribution rights.                                                                                                                                                                                                             |
| **P0**                                | Owner confirms eligibility/current form, provides real public links and submits Devpost            | Deadline supplied by owner: **October 31, 2026, 11:45 AM Beijing**. Copy-ready content is prepared, not submitted. Confirm that the chosen evidence/demo satisfies meaningful Qloo integration and working-public-demo requirements.                                                                                                    |
| **Conditional P0 for real-Qloo mode** | Confirm event quota/expiry and retention/display/sharing rights, then authorize bounded validation | Unknown figures or general kit guidance are not permission grants. These do not block local synthetic work, but block real-provider activation and third-party transfer.                                                                                                                                                                |
| **P1**                                | Hosted acceptance, backup/restore, availability through judging and sample expiry                  | Requires an approved host/URL. Oracle account readiness is external; the low-cost fallback is documented without purchase.                                                                                                                                                                                                              |
| **P1**                                | Remote CI/CodeQL and AMD64 check if choosing CX23                                                  | No push was authorized; local ARM64 evidence does not prove remote/x86 acceptance.                                                                                                                                                                                                                                                      |
| **P1**                                | Final image-specific dependency notices if distributing binaries                                   | Local manifest inventory is complete for installed packages, not a license opinion or image SBOM. Source dependencies retain their own licenses.                                                                                                                                                                                        |
| **P2**                                | Optional short narrated video; more real-data quality evaluations after approval                   | Neither should be presented as already completed.                                                                                                                                                                                                                                                                                       |

Independent development is complete for this checkpoint. No organizer inquiry was sent and no task was left waiting for an organizer response.
