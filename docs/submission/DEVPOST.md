# Tessaloom — Devpost submission (copy-ready)

Updated 2026-10-27. **Nothing has been submitted.** Every statement below was checked against the
code, the tests or a recorded run. The only open fields are marked `[…]`:

| Placeholder | Filled when |
| --- | --- |
| `[RUN_DATE]`, `[PRODUCTION_RESULT]` | The single paid production acceptance passes ([runbook](PRODUCTION_FIRST_RUN.md) §4) |
| `[JUDGE_CODE_1]` … `[JUDGE_CODE_4]`, `[CODE_EXPIRY]` | The four judge codes exist and one redemption is verified (§5.2) |
| Organizer-dependent wording | Qloo answers the display question posted on the Devpost discussion forum (pending) |

## Links

- **Demo:** https://p01--tessaloom--mpfcqkyl42yb.code.run (public HTTPS; verified 2026-10-27)
- **Repository:** https://github.com/LZH-1-G/tessaloom (public; GitHub detects the MIT License)

## Project name

Tessaloom

## Tagline

Weave cultural connections into testable creative experiences.

## Short description

Tessaloom helps small venues turn cross-cultural inspiration into evidence-aware event plans.
Claude agents use Qloo as their tool to find connections between cultural worlds, propose
hypotheses, test every claim against Qloo results with fixed rules, and compose an editable
blueprint in which each statement is labelled as Qloo evidence, AI interpretation or creative
speculation.

## 60–90 second pitch

> A small café wants a quiet Tuesday to become a night people come back for. The owner knows
> their regulars love _Spirited Away_ and Joe Hisaishi, but has no data team. Ask a chatbot and
> you get a confident idea with no way to tell a hunch from a fact.
>
> Tessaloom gives that owner a team of Claude agents with Qloo as their instrument. Qloo
> resolves each interest, then threads it into film, music, books and places; items reached from
> both interests become bridges between worlds. In our recorded run there were 93. Claude
> proposes hypotheses, and every claim becomes a Qloo query graded by a fixed rule: _Kiki's
> Delivery Service_ ranked first of six Ghibli films for this audience. That is Qloo data. The
> critic's caution is labelled AI interpretation. The event concept is labelled creative
> speculation.
>
> The result is a plan the owner can run next month, with a traceability meter showing what is
> evidence, what is interpretation and what is imagination, and a read-only story they can share.
> Qloo supplies the taste signals, Claude reasons over them, and Tessaloom keeps the evidence and
> the imagination apart.

## The problem and who it's for

Owners and programmers of small cafés, bookstores, libraries, galleries and community venues
want new recurring events their audience will actually come to. They know what their regulars
love but have no analyst. A recommendation list doesn't answer their real question: _could
these different cultural worlds become one experience, and which parts of that idea are backed
by evidence?_ Typical uses are a monthly themed evening, a pop-up that pairs two fan
communities, or a quiet-night series that needs a reason to return.

## What it does: key features and workflow

1. **Brief.** The owner describes the venue, audience goal, constraints and two to six
   interests. A Claude agent interprets it into an intent and asks when something is ambiguous
   ("the novel or the film?").
2. **Entity selection.** Qloo search resolves each interest; the owner confirms the intended
   entity. Nothing ambiguous is chosen for them.
3. **Discovery canvas.** Qloo recommendations thread each interest into film, music, books and
   places. Items reached from more than one interest, or sharing Qloo themes across worlds,
   become bridges. Canvas and list views, filters by world, "bridges only", and a tension slider
   from familiar to surprising.
4. **Hypothesis lab.** Claude writes competing hypotheses, each with testable claims. Each claim
   compiles to a typed Qloo query (shortlist ranking, tag resonance, audience comparison,
   cross-domain affinity), and a deterministic evaluator grades it: supports, contradicts,
   neutral or insufficient. A critic agent can downgrade or add interpretation but can never
   change a stance.
5. **Evidence graph.** Entities, hypotheses, claims and evidence in one inspectable graph, each
   node labelled Qloo data, AI interpretation or creative speculation, with a request-to-result
   trace for every Qloo call.
6. **What-if lab.** Change one variable (swap a seed, adjust weights, change the tension) and
   Tessaloom computes dependencies first: unaffected evidence is reused, affected queries rerun,
   and a weights-only change rescales without new data. Comparisons show which ideas entered,
   exited or changed stance.
7. **Blueprint.** The composer turns the chosen hypothesis into a plan (concept, audience,
   format, programme, constraints, measurement) with a traceability meter, citations that open
   the stored evidence, editable blocks, revisions, Markdown/JSON export and print.
8. **Read-only story.** Share the whole experiment (brief, discovery, tested hypotheses,
   blueprint, limits) through a revocable, expiring link that works without an account.

## How Qloo is used (and why an LLM alone isn't enough)

An LLM can invent a plausible pairing; it can't tell you whether two audiences actually overlap.
Tessaloom uses the Qloo Insights API, through the official Qloo Harness (0.1.26), for exactly
that:

- **Search** resolves "Spirited Away" to one cultural entity the owner confirms.
- **Recommendations** thread each interest into other domains; the bridges between worlds come
  from Qloo's own results, not the model's guesses (93 in the recorded run).
- **Ranking** grades shortlist claims ("ranked 1 of 6, top third").
- **Entity tags** grade theme claims ("carries the theme tag 'Animation'").
- **Audience comparison** grades overlap claims.

Every Qloo-backed statement carries its origin (live or cache), the retrieval date and the rule
that graded it. Cached evidence keeps its original date. Raw responses are not stored, and no
Qloo response data is in the public repository.

## How the Claude agents operate

Six roles run inside a recoverable state machine on a pg-boss worker; five of them call Claude
Sonnet 5.5:

| Role | Does | Guardrails |
| --- | --- | --- |
| R1 Intent | Brief → intent frame and ambiguity questions | JSON Schema output; asks instead of guessing |
| R2 Discovery | Plans and runs the Qloo threads (no LLM) | Bounded calls per run |
| R3 Hypotheses | Writes hypotheses and their testable claims | Claims must reference resolved entities; no causal or individual-level claims |
| R4 Critic | Reviews evidence; may downgrade or add interpretation | Cannot change an evaluator's stance |
| R5 What-if narrator | Explains a branch comparison | Grounded in computed metrics |
| R6 Composer | Turns the chosen idea into a blueprint | Every evidence block must cite stored evidence; traceability check before completion |

All calls go through one gateway: structured output with JSON Schema, semantic validators
(grounded entities, no sensitive traits, no causal claims), at most one repair attempt, and a
cost reservation **before** every attempt. Human confirmation gates sit between stages, and every
step is visible in a live "Decisions & actions" panel.

## Technical architecture

TypeScript monorepo deployed as one Northflank service: a Next.js web process and a pg-boss
worker under one supervisor with separate environment allowlists, so provider keys reach only
the worker and never the browser or the web process. PostgreSQL (Drizzle) stores experiments,
evidence, the spend ledger and run events. Packages: `core` (domain and evaluators), `agent`
(state machine and roles), `llm-gateway`, `qloo-adapter`, `db`, `config`.

## Security and cost controls

- **Access.** Agent runs need an invitation code with its own lifetime cap; anonymous visitors
  can read samples and shared stories but cannot start runs. Codes are stored only as hashes,
  expire, and can be revoked immediately.
- **Budgets.** Global, workspace and experiment caps per day; a per-code cap; one active run per
  workspace; a global working-run limit; a daily Qloo call limit. Every model attempt, including
  repairs and queue retries, reserves its upper-bound cost first; a reservation that does not fit
  is never sent, and unknown outcomes stay charged.
- **Web security.** CSRF protection on every write, HttpOnly/SameSite cookies, per-workspace
  isolation, rate limits, nonce CSP, HSTS and frame denial. No HTTP admin surface.
- **Data.** Raw Qloo responses are not retained; public pages and shared exports omit Qloo IDs,
  popularity and affinity values, and descriptions.

## Testing and experimental results

- **Real end-to-end run (2026-10-26, local).** Brief → entity selection → live Qloo discovery →
  hypotheses → blueprint for _Spirited Away_ + Joe Hisaishi. All five Claude calls passed schema
  and semantic validation on the first attempt; Qloo produced 93 cross-world bridges; five
  hypotheses were graded against live Qloo evidence; all seven blueprint citations resolve. This
  run used the official Claude Agent SDK on the developer's own Claude subscription (personal
  use, no API charge).
- **Production run.** `[PRODUCTION_RESULT]` (the same scenario through the Anthropic API on the
  public deployment, with date and measured cost).
- **A harder pair.** _Norwegian Wood_ + Nujabes produced too few bridges; the app explains the
  stop and suggests adding or broadening an interest instead of failing silently.
- **Automated tests (2026-10-27).** 469 unit, 96 PostgreSQL integration and 16 runtime tests; 34
  Chromium + WebKit end-to-end journeys with axe accessibility checks; the invite-code journey;
  read-only sample checks. CI also runs dependency and secret scanning, CodeQL and a Docker image
  smoke test.

## Engineering challenges and what we learned

Provider responses don't match a convenient abstraction: audience profiles are not similarity
percentages, affinity is not probability, and an absent result doesn't prove two audiences don't
overlap. We built deterministic evaluators and an explicit "insufficient" stance around those
limits. A cache timestamp can make old evidence look fresh, so retrieval dates survive caching,
database views and What-if branches. Making spending fail closed across repairs, fallbacks,
queue retries and crashes needed one ledger that reserves before every attempt.

## Known limitations

- Qloo values are aggregate taste signals: Tessaloom makes no attendance, sales, causal or
  individual-level claims.
- Some interest pairs yield too few bridges; the app says so and suggests a third interest.
- Evaluator thresholds are calibrated on a small number of live briefs.
- Agent runs are invitation-only to bound cost; the public site otherwise offers read-only
  content.
- Inside the studio, signed-in users see Qloo's short entity descriptions and the Qloo ID behind
  each grading in the evidence trace; public pages and shared exports do not. Display rights are
  pending Qloo's reply.

## What's next

Calibrate evaluator thresholds across many more live briefs, add a guided third-interest
suggestion when bridges are scarce, and let venues compare real attendance with the blueprint's
measurement plan.

## Built with

TypeScript, Next.js, React, Tailwind CSS, React Flow, PostgreSQL, Drizzle ORM, pg-boss, Zod,
Qloo Insights API (Qloo Harness), Claude Sonnet 5.5 (Anthropic API), Claude Agent SDK (local
development), Vitest, Playwright, axe-core, Docker, Northflank.

## Testing instructions (paste into Devpost's testing field)

**1. Read a finished experiment (no code, no cost).** Open
https://p01--tessaloom--mpfcqkyl42yb.code.run → **Demo samples** → **Spirited sound evenings**
(recorded `[RUN_DATE]` with live Qloo data and Claude). The page walks through the brief, the
Qloo discovery, the cultural bridges, the hypotheses with each claim's Qloo evidence, the
blueprint with citations, and the limitations.

**2. Run the agent yourself (access code).** On the home page, open **Unlock AI runs** and enter
one code: `[JUDGE_CODE_1]` · `[JUDGE_CODE_2]` · `[JUDGE_CODE_3]` · `[JUDGE_CODE_4]`. Each code
allows three full workflows until `[CODE_EXPIRY]` and has its own spending cap. Then:

1. Create a café project and write a brief with two or three interests, such as a film and a
   musician.
2. **Interpret brief**, then **Confirm & discover**.
3. Pick the intended entities if asked (**Confirm choices**), then **Generate hypotheses** from
   the collision pool.
4. Open **Inspect evidence** on a hypothesis, then **Compose blueprint**.

Each stage takes a few seconds to about a minute; the "Decisions & actions" panel shows progress.

**Troubleshooting**

- _"The studio is busy"_: another judge's run is in progress. Try again in a minute.
- _Too few bridges_: that interest pair has little cross-world overlap in Qloo. Add a third
  interest or broaden one, then run again.
- _"This access code is not valid or no longer active"_: check for spaces, or use another of the
  four codes.
- _"Lots of new visitors right now"_: wait a minute, then reload.
- A run that stops shows the reason and what to do next; saved work is never lost.

**3. Reproduce locally (no keys).** See the
[README quick start](https://github.com/LZH-1-G/tessaloom#readme); synthetic data is labelled
"FIXTURE — not real Qloo data".

### Fallback testing text (only if the paid run and codes are not ready by Oct 30)

> This does **not** fully meet the rule that judges can run the agent themselves; prefer
> finishing §4–§5.2.

Open https://p01--tessaloom--mpfcqkyl42yb.code.run to see the studio and its health. Interactive
runs are switched off on the public site while the final production check is pending. To run the
complete workflow, follow the [README quick start](https://github.com/LZH-1-G/tessaloom#readme)
(Docker; synthetic fixture data, no keys).

## Gallery captions (images are delivered to the owner, not in the repository)

| File | Caption |
| --- | --- |
| `1-discovery-canvas.png` | Qloo threads _Spirited Away_ and Joe Hisaishi into film, music, books and places; items reached from both interests become bridges. |
| `2-hypothesis-evidence.png` | Each claim becomes a Qloo query graded by a fixed rule: "ranked 1 of 6 (top third)". A critic agent adds interpretation but cannot change a stance. |
| `3-evidence-graph.png` | Cultural entities, hypotheses, claims and evidence in one graph, each labelled Qloo data, AI interpretation or creative speculation. |
| `4-blueprint.png` | The composed plan with its traceability meter: 13% evidence-backed, 53% interpretation, 33% speculation; 7 citations, all resolving to stored evidence. |
| `5-story-phone.png` | The read-only story on a phone: 93 candidate bridges, 3 taken forward, hypotheses tested against Qloo evidence. |

## Video description

> **Tessaloom in 1:43.** A café owner's brief (_Spirited Away_ + Joe Hisaishi) becomes a tested
> event plan: Qloo resolves the interests and finds 93 cross-world bridges, Claude agents propose
> hypotheses whose claims are graded against Qloo results by fixed rules, and the composer
> produces a blueprint whose every statement is labelled evidence, interpretation or
> speculation. Recorded from a saved run with live Qloo data (retrieved 2026-10-26) and Claude
> Sonnet 5.5; no new calls were made while recording. Narration is synthetic (macOS voice).

Files: `tessaloom-demo.mp4` (1440 × 900, narrated, subtitled) and `tessaloom-mobile-story.mp4`
(phone, 27 s). Upload as **unlisted** on YouTube or Vimeo and paste the link. A video is
optional under the rules, and both files contain Qloo-derived names: upload only once Qloo's
reply allows it, or accept that risk knowingly.

## Tools and attribution

- **Cultural data:** Qloo (Insights API through the official Qloo Harness).
- **AI agents:** Anthropic Claude: Claude Sonnet 5.5 via the Claude API in deployment; the
  official Claude Agent SDK on the developer's own Claude subscription for local development
  only.
- **Development:** assisted by Claude Code and Codex. All code is the entrant's project and is
  MIT licensed; dependencies keep their own licenses.
- **Demo narration:** macOS text-to-speech.

## Rules compliance (official rules read 2026-10-26; a re-read on 2026-10-27 was blocked by the site's bot check)

| Requirement | How Tessaloom meets it | Status |
| --- | --- | --- |
| Working app using the Qloo API as an agentic tool | Qloo Harness workflows drive resolution, discovery and every claim test inside a multi-role Claude agent loop | Verified locally with live Qloo + Claude; production run pending |
| Link to a functional demo | https://p01--tessaloom--mpfcqkyl42yb.code.run | Verified 2026-10-27 |
| Judges can test free of charge until judging ends (Nov 2–5); credentials in testing instructions | Read-only story without a code; capped access codes for interactive runs | Codes pending the paid acceptance (§4–§5.2) |
| Public repository with a detectable open-source license | MIT `LICENSE`; GitHub detects it | Verified |
| English text description | This document | Ready |
| Third-party APIs within their terms | Anthropic API key for public inference; subscription local-only and refused in production; Qloo data server-side only | Verified in code and tests |
| Video | Optional | Prepared (two files; owner uploads) |

## Submission checklist (owner)

- [x] Public demo URL works over HTTPS.
- [x] Public repository with MIT license detected.
- [x] Qloo display and judge-access question posted on the Devpost forum (2026-10-26). **Reply pending**; apply its answer table in [QLOO_PERMISSION_REQUEST.md](QLOO_PERMISSION_REQUEST.md).
- [x] Five gallery screenshots with captions; two demo videos (delivered to the owner, not committed).
- [ ] By Oct 29: final paid acceptance passed ([runbook](PRODUCTION_FIRST_RUN.md) §4); story sample featured (§5.1).
- [ ] By Oct 29: four judge codes, judging limits, `RUN_ACCESS=invite`; one code redeemed in a fresh browser (§5.2).
- [ ] Fill `[RUN_DATE]`, `[PRODUCTION_RESULT]`, `[JUDGE_CODE_1–4]`, `[CODE_EXPIRY]`; paste the testing instructions into the testing field only.
- [ ] Upload the screenshots and (optionally) the video link; review built-with tags, team members and the AI-assistance disclosure.
- [ ] Oct 30 before 6 PM ET: `node deploy/public-smoke.mjs https://p01--tessaloom--mpfcqkyl42yb.code.run`, then open the sample.
- [ ] **Owner's final approval**, then submit before **Oct 30, 2026, 11:45 PM ET** (Oct 31, 11:45 AM Beijing). Judging runs Nov 2–5.
