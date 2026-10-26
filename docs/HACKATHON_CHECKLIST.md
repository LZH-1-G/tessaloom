# Tessaloom — Hackathon Rules and Submission Compliance Checklist

> M11 rules recheck (2026-10-24): the official rules are now readable; see [current source and calendar](M11_HOSTING.md). Deadline: **October 31, 11:45 Beijing time**. The page currently lists judging November 2–5, which differs from the historical November 2–16 record below. Maintain the conservative November 30 availability target. Public access, quota policy and home-tunnel compliance are not certified by this checklist.

> Submission preparation update (2026-10-24): see [current acceptance](submission/ACCEPTANCE.md) and [deployment decision](submission/DEPLOYMENT.md). This earlier milestone/checklist remains historical. Production still rejects fixture generation and fixture reads; no public-demo exception has been approved. The current deployment preparation also creates an empty worker-only `deepseek_key` file.

> **Event:** Qloo Agentic Hackathon 2026 (Devpost: https://qloo.devpost.com/)
> **Status:** v1.1 · updated 2026-10-20 (architecture review) · **No submission item is complete yet**, except where evidence is cited.
> **Deadline:** **Friday, October 30, 2026, 11:45 PM EDT** = 2026-10-31 03:45 UTC. DST in the US ends Sunday, Nov 1, 2026, so EDT (UTC−4) applies.
> **Internal targets:** code freeze 18:00 EDT · submission 21:00 EDT on Oct 30.

---

## 1. Sources and verification status

| Source | How verified | Result |
|---|---|---|
| **Official rules page**, https://qloo.devpost.com/rules | **Externally verified by the project owner against the official Devpost rules page (reported 2026-10-20).** The assistant could **not** fetch the page directly: automated requests receive HTTP 403 / a Cloudflare bot challenge, and the assistant did not attempt to bypass it. | The facts in §1.1 are recorded as **EXTERNALLY VERIFIED (owner, official rules)** |
| Devpost public hackathon listing API (`devpost.com/api/hackathons?search=qloo`) | Fetched by the assistant on 2026-10-20 | "Qloo Agentic Hackathon": submission period **Sep 30 – Oct 30, 2026**, **$25,000** in prizes, **Online** |
| Official kit, https://github.com/qloo/qloo-hackathon-kit | Cloned and read by the assistant (commit `80a82b2`; re-checked 2026-10-20, no newer commits) | API access rules, safe use, submission guide, support and security contacts |
| `@qloo/qloo-harness` on npm | `npm view` by the assistant, 2026-10-20 | Latest `0.1.26` (published 2026-09-23); `node >=22.19.0` |

### 1.1 Rules facts confirmed from the official rules (externally verified)

| # | Fact | Label |
|---|---|---|
| F1 | Submission deadline: **October 30, 2026, 11:45 PM EDT** | EXTERNALLY VERIFIED |
| F2 | **Individual participation is permitted** | EXTERNALLY VERIFIED |
| F3 | A **working application with meaningful Qloo API integration** is required | EXTERNALLY VERIFIED |
| F4 | A **functional, publicly accessible demo link** is required | EXTERNALLY VERIFIED |
| F5 | A **public, open-source repository with a detectable license** is required | EXTERNALLY VERIFIED |
| F6 | An **English project description** is required | EXTERNALLY VERIFIED |
| F7 | A **demonstration video is not explicitly mandatory** in the formal submission requirements | EXTERNALLY VERIFIED |
| F8 | **Judging runs November 2 – November 5, 2026** (rules re-read 2026-10-26; the 2026-10-24 reading said Nov 2–16) | EXTERNALLY VERIFIED 2026-10-26 |
| F9 | Four **equally weighted** judging criteria: **Technological Implementation, Design, Potential Impact, Quality of the Idea** | EXTERNALLY VERIFIED |

Anything not in §1.1, the kit, or the listing API is still **UNVERIFIED** (§3).

---

## 2. Compliance checklist

Legend: **Status** is `TODO` / `IN PROGRESS` / `DONE (evidence)` / `N/A`.

### 2.1 Qloo integration

| # | Requirement | Source | How Tessaloom satisfies it | Status |
|---|---|---|---|---|
| Q1 | **Meaningful Qloo API integration** in a working application | Rules F3; kit SUBMISSION.md (*"use Qloo results as evidence in a clear product flow"*) | Qloo powers entity resolution, discovery threads, every claim test, counterfactual recomputation, and blueprint evidence (API_CONTRACTS §5) | TODO |
| Q2 | Use only supported surfaces (`qloo explore/exec/api/mcp`, harness ≥ 0.1.26) | Kit API_ACCESS.md, manifest | The worker process uses `qloo mcp` (primary) and `qloo exec` / `qloo api` (secondary). No direct REST (ADR-003). | TODO |
| Q3 | No excluded components (`integrate/plan/build` modes, hosted Qloo API MCP endpoints, legacy `qloo api mcp`, docs-MCP `execute-request`) | Kit manifest, README, API_ACCESS.md | None used; a code-review checklist item in every PR | TODO |
| Q4 | Individually attributable credential; never in the repo, browser, MCP config, or recordings | Kit API_ACCESS.md | SECURITY §3 | TODO |
| Q5 | Respect the event quota; bounded retries; no bulk scraping | Kit API_ACCESS.md | Quota guard, cache, budgets, bounded retries | TODO (quota value unknown) |
| Q6 | Responsible data handling: aggregate affinities only, no personal data to Qloo, source and limits presented | Kit SAFE_USE.md | SECURITY §5, the provenance UI, the safe-use validator | TODO |
| Q7 | No mock or fixture data presented as Qloo results | Project policy (honesty; supports F3) | The fixture firewall (ADR-014; API_CONTRACTS §6.4) | TODO |

### 2.2 Eligibility

| # | Requirement | Source | Status | Notes |
|---|---|---|---|---|
| E1 | Individual participation permitted | Rules F2 (externally verified) | **Satisfied** | Tessaloom is a solo project |
| E2 | Personal eligibility (age of majority, country, employee exclusions) | Official rules (details not provided to the assistant) | **Owner to confirm** | The owner should re-read the eligibility section personally |
| E3 | Treatment of pre-existing work / creation during the period | Official rules (details not provided) | **UNVERIFIED** | Initial commit 2026-10-20 (within Sep 30 – Oct 30). Git history is evidence. |
| E4 | Use of AI coding assistants and third-party libraries | Official rules (details not provided) | **UNVERIFIED** | Disclose Claude Code / Codex use in the README for transparency |
| E5 | Registered on Devpost for this hackathon | Devpost | **Owner to confirm** | — |

### 2.3 Submission requirements

| # | Requirement | Source | How satisfied | Status |
|---|---|---|---|---|
| D1 | **Working application** | Rules F3 | Hosted app passing the TEST_PLAN §13 smoke tests | TODO |
| D2 | **Functional, publicly accessible demo link** | Rules F4 | Always-on single deployment (ADR-017); no sign-up; sample projects; live runs within the quota guard | TODO |
| D3 | Demo must not expose credentials or personal data | Kit SUBMISSION.md item 4 | SECURITY §10 checklist | TODO |
| D4 | **Public, open-source repository** | Rules F5 | `github.com/LZH-1-G/tessaloom` is currently **private**. The owner makes it public before submitting, after a full-history gitleaks scan. | TODO |
| D5 | **Detectable license** | Rules F5 | MIT License in `LICENSE` at the repository root (standard MIT text, which GitHub's license detection recognizes; confirm the "MIT" badge appears on the public repo page) | DONE for file presence (evidence: `LICENSE` at commit `4e27712`); detection check TODO after going public |
| D6 | **English project description** | Rules F6 | README + Devpost description in English | TODO |
| D7 | Supporting technical documentation | Owner's brief | `docs/` (12 documents) + the README technical summary | IN PROGRESS (baseline and review completed 2026-10-20) |
| D8 | Short product problem statement | Kit SUBMISSION.md item 1 | README "Problem" section | TODO |
| D9 | Qloo workflows or MCP tools used, and why they fit | Kit SUBMISSION.md item 2 | README section from API_CONTRACTS §5.4 (with live-verified status) | TODO |
| D10 | Redacted request-to-result explanation, incl. entity/tag choices | Kit SUBMISSION.md item 3 | In-app Evidence Trace + a README walkthrough of one claim | TODO |
| D11 | Setup steps from a clean environment | Kit SUBMISSION.md item 5 | README quick start: fixture mode (no key) and live mode (own key); docker-compose | TODO |
| D12 | Known limitations (what results do not establish) | Kit SUBMISSION.md item 6 | README "Limitations" | TODO |

### 2.4 Demonstration materials

| # | Item | Source | Status |
|---|---|---|---|
| V1 | Demo video | Rules F7: **not explicitly mandatory**. The kit suggests *"a short demo or screenshots"*. | **Recommended, optional.** A ≤ 3-minute walkthrough, if time allows on D10. Screenshots are the minimum. |
| V2 | Video storyline: problem → brief → hypotheses with evidence → what-if comparison → blueprint → provenance and trace | Internal plan | TODO (only if V1 is produced) |
| V3 | Screenshots for the Devpost gallery | Devpost / kit | TODO (required minimum per our plan) |
| V4 | Any recording or screenshot follows the hygiene checklist (REPLAY mode, no secrets) | SECURITY §10 | TODO |

### 2.5 Deadlines and timing

| # | Item | Time (EDT) | Label |
|---|---|---|---|
| T1 | Submission period | Sep 30 – Oct 30, 2026 | Devpost listing API |
| T2 | **Submission deadline** | **Oct 30, 2026, 11:45 PM** | EXTERNALLY VERIFIED (F1) |
| T3 | Internal code freeze | Oct 30, 18:00 | Plan |
| T4 | Target submission | Oct 30, 21:00 | Plan |
| T5 | **Judging period** | **Nov 2 – Nov 5, 2026** (availability kept through Nov 16 as a buffer) | EXTERNALLY VERIFIED (F8, 2026-10-26) |
| T6 | Demo must stay available | From submission through **at least Nov 16, 2026, 23:59 EST** (+ a 14-day buffer to Nov 30) | Plan derived from F4 + F8 |
| T7 | Winners announcement | UNVERIFIED | — |

### 2.6 Evaluator accessibility and availability during judging

| # | Requirement | How satisfied | Status |
|---|---|---|---|
| A1 | Judges can use the app without credentials | Anonymous workspace; sample projects | TODO |
| A2 | Judges understand the value in minutes | Onboarding tour; samples open in the Hypothesis Lab (UI_UX_SPEC §7) | TODO |
| A3 | Service available Oct 30 – Nov 16 (and through the buffer) | Always-on single service; platform health check on `/api/health/ready`; supervisor restarts (ADR-017); an external uptime monitor every 5 minutes | TODO |
| A4 | Works if the Qloo quota is exhausted or the credential expires | Sample projects in REPLAY (pending R-08); clear banners; no fixture fallback | TODO |
| A5 | **Qloo credential valid through Nov 16** | Ask the organizers (kit API_ACCESS says they publish the expiration) | **UNVERIFIED** |
| A6 | Testing instructions for judges | README "For judges" section + Devpost testing instructions field | TODO |
| A7 | Cross-browser support | Playwright Chromium + WebKit smoke | TODO |
| A8 | LLM budget covers judging traffic | Global daily cap; replay samples need no LLM calls; cost model in DECISIONS ADR-018 | TODO |

### 2.7 Judging criteria (four, equally weighted; externally verified F9)

| Criterion (25% each) | What judges should see | Primary evidence in Tessaloom | Owner docs |
|---|---|---|---|
| **Technological Implementation** | A real agent with durable state, evidence-driven decisions, and meaningful Qloo use | State machine with budgets and recovery; deterministic evaluators; dependency-aware counterfactual recomputation; harness MCP integration; test suite and CI | ARCHITECTURE, AGENT_WORKFLOW, API_CONTRACTS, TEST_PLAN |
| **Design** | A polished, distinct, understandable studio experience | The "Loom" visual identity; provenance visual language; Discovery Canvas lanes; Hypothesis Lab cards; What-if comparison; accessibility (WCAG 2.2 AA) | UI_UX_SPEC |
| **Potential Impact** | Real value for independent venues and organizers; extensibility | Brief-to-blueprint in minutes; exportable, evidence-traceable plans; a generic domain model for other use cases | PRD §3, §4, §8 |
| **Quality of the Idea** | Originality beyond "recommender + AI" | Collision Engine, Hypothesis Loop, Counterfactual Engine, Evidence Graph, Explainable Synthesis | ORIGINALITY_STRATEGY |

**Implication for the build.** "Design" carries the same weight as the technical work. The implementation plan reserves UI polish time in M7, M9, and M10 and does not treat design as stretch work.

---

## 3. Items still unverified

1. Personal eligibility details (age, country, employee/affiliate exclusions): **owner to confirm personally**.
2. Rules on pre-existing work and on AI-assistant use.
3. IP/licensing terms beyond "open-source license with a detectable license", and disqualification conditions.
4. The event Qloo quota, rate limits, and credential expiry, including validity through Nov 16 (A5).
5. Whether storing and replaying Qloo responses in a public demo is permitted under Qloo's terms (R-08).
6. The winners announcement date.

---

## 4. Pre-submission final gate (run on Oct 30)

- [ ] All rows in §2.1–§2.3 are DONE with evidence
- [ ] Full-history gitleaks: 0 findings
- [ ] Repository public; GitHub shows the detected **MIT** license; README complete in English
- [ ] Hosted demo URL works in a private window (Chromium + WebKit)
- [ ] `/api/health/ready` = 200; `/api/health/qloo` shows the live adapter ready
- [ ] Sample projects open with the REPLAY badge (or live-on-demand per the R-08 contingency)
- [ ] No FIXTURE banner and no `DEVELOPMENT_FIXTURE` data in production
- [ ] Screenshots uploaded; demo video uploaded and tested logged-out (**optional**)
- [ ] Devpost form complete: English description, Qloo usage explanation, demo link, repository link, testing instructions
- [ ] Submitted before **21:00 EDT**; confirmation screenshot saved
- [ ] Deployment set to always-on through **Nov 16, 2026** + buffer (Nov 30); LLM spend limit and the Qloo quota guard reviewed for judging traffic
