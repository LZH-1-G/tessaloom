# Tessaloom — Devpost copy-ready content

Prepared 2026-10-24, updated 2026-10-26. Nothing has been submitted. Add the approved public demo and repository URLs in Devpost's link fields only after they actually work. The text below describes the current implementation and explicitly identifies the demonstration's data source.

## Project name

Tessaloom

## Tagline

Weave cultural connections into testable creative experiences.

## Short description

Tessaloom helps small venues turn cross-cultural inspiration into evidence-aware experiments. Its agents discover connections, propose hypotheses, test claims, visualize provenance, compare dependency-aware What-if branches, and compose editable experience blueprints. Claude agents reason over live Qloo audience signals, and every blueprint statement is labelled as evidence, interpretation or speculation.

## Inspiration

A small bookstore or café does not need another endless list of recommendations. It needs to answer a harder question: “Could these different cultural worlds become an experience our community would want to try—and which parts of that idea do we actually have evidence for?”

We wanted a tool that keeps creative possibility and evidential confidence separate. A surprising connection can inspire an event without proving that the event will succeed.

## What it does

Tessaloom turns a creative brief into a persistent experiment. Users confirm their cultural interests, explore cross-domain discovery threads, curate a collision pool and review competing hypotheses. Each hypothesis includes testable claims, explicit evidence stances and creative elements.

The Evidence Graph connects cultural entities, hypotheses, claims and evidence. Source labels and request traces let users distinguish provider facts, computed values, interpretation, speculation and synthetic fixtures. Cached evidence keeps its original retrieval date, so reuse cannot make an old result look freshly retrieved.

The What-if engine changes one variable while holding the rest of the experiment explicit. It computes dependencies before running work: unaffected evidence is reused, affected queries are recomputed, and a weights-only change rescales the comparison without requesting new cultural data. Users can then compose an experience blueprint with practical constraints, traceable references, editable blocks, revision history, Markdown export and revocable read-only sharing.

## Who it's for

Owners and programmers of small cafés, bookstores, libraries, galleries and community venues
who want a new recurring event their audience will actually come to. They know what their
regulars love but have no data team. Typical uses: a monthly themed evening, a pop-up pairing
two fan communities, or a quiet-night series that needs a reason to return.

## How we built it

The application uses TypeScript, Next.js, React, PostgreSQL, Drizzle and pg-boss. A persistent worker executes a recoverable state machine with six specialized roles: intent analysis, cultural discovery, hypothesis generation, evidence criticism, counterfactual explanation and blueprint composition. Human confirmation gates control important transitions. Typed evidence plans and deterministic evaluators constrain what an LLM can claim.

Qloo integration uses the official Harness through supported workflows and typed adapters. Search and entity resolution establish the intended cultural inputs; recommendations, rankings, tags and audience comparisons supply evidence for cross-domain claims. The adapter normalizes different response shapes, records provenance, separates cache reuse from retrieval, and enforces bounded requests. Unsupported or inadequate evidence remains insufficient rather than being converted into a confident conclusion.

Five Claude roles (intent, hypothesis generation, evidence critic, What-if narrator, blueprint composer) run through an LLM gateway that enforces JSON Schema structured output, semantic validators (grounded entities, no causal or individual-level claims, no sensitive traits), at most one repair, and a spending reservation before every call. Deployment uses Claude Sonnet 5.5 through the Anthropic API; local development can use the official Claude Agent SDK on the developer's own subscription, which the production configuration refuses. Web and worker processes run as separate identities, and provider credentials never reach the browser or the web process.

## What makes it original

The contribution is the complete creative hypothesis loop, not simply combining two recommendation lists. A cultural connection becomes a testable claim, enters an inspectable evidence graph, survives a controlled counterfactual comparison, and becomes a practical blueprint whose assumptions remain visible. Dependency-aware reuse makes the experiment cheaper and more explainable at the same time.

## Why Qloo matters (not just an LLM)

An LLM alone can invent a plausible pairing, but it can't tell you whether the audiences
actually overlap. Tessaloom uses Qloo for exactly what a language model can't supply:

- Resolving "Spirited Away" to one cultural entity.
- Recommending what fans of each interest also like across books, music, film and places.
- Ranking a shortlist for an audience.
- Comparing two audiences.
- Reading taste themes.

Every claim the agents make is turned into one of those queries and graded by fixed rules. The
blueprint therefore separates "Qloo shows this" from "the AI suggests this". In the recorded run, all 93 cross-world bridges came from Qloo's recommendation threads for
the two interests: pairs of items from different worlds that connect both interests through
Qloo's own results, not through the model's guesses.

## Challenges and what we learned

Provider responses do not always match a convenient product abstraction. Audience profiles are not similarity percentages, affinity is not probability, and absent results do not prove an audience relationship is impossible. We designed deterministic evaluators and uncertainty labels around those limits.

We also found that a cache timestamp can accidentally imply fresh evidence. Preserving original snapshots and retrieval dates across database views and What-if branches was essential to making the graph trustworthy.

## Validation and current limitations

On 2026-10-26 the complete workflow (brief, entity selection, live Qloo discovery and evidence, hypotheses, blueprint) ran end to end with live Qloo data and Claude Sonnet 5.5. All five Claude calls passed schema and semantic validation on the first attempt. Qloo produced 93 cross-world bridges, five hypotheses were graded against live Qloo evidence, and all seven blueprint citations resolve to stored evidence. That run used the official Claude Agent SDK on the developer's own Claude subscription, locally (personal use, no API charge). [PRODUCTION_RESULT: the same scenario through the Anthropic API on the public deployment, with date and cost.]

A second live pair (*Norwegian Wood* + Nujabes) produced too few cross-world bridges. The app now explains this outcome and suggests adding or broadening interests instead of failing silently. A separate local demo mode uses synthetic data and scripted AI, labelled “FIXTURE — not real Qloo data”; production refuses fixture data.

Qloo values are aggregate taste signals: no attendance, sales, causal or individual-level claims are made. Raw Qloo responses are not retained, and no Qloo response data is stored in the public repository. Paid generation is invitation-only behind per-run, per-grant and daily spending caps.

## What's next

Calibrate evaluator thresholds across many more live briefs, add a guided third-interest suggestion when bridges are scarce, and let venues compare real attendance against the blueprint's measurement plan.

## Built with

TypeScript, Next.js, React, Tailwind CSS, React Flow, PostgreSQL, Drizzle ORM, pg-boss, Zod, Qloo Harness, Claude Sonnet 5.5 (Anthropic API), Claude Agent SDK (local development), Vitest, Playwright, axe-core, Docker, Caddy.

## Testing instructions

> Fill the bracketed values only after the public URL and the final acceptance run are verified
> ([runbook](PRODUCTION_FIRST_RUN.md) §2.1 and §4–§5). Until then, keep this section out of Devpost.

**1. Read a finished experiment (no code, no cost).** Open [PUBLIC_URL] → **Demo samples** →
**Spirited sound evenings** (recorded [RUN_DATE] with live Qloo data and Claude). The page walks
through the brief, the Qloo discovery, the cultural bridges, the hypotheses with each claim's
Qloo evidence, the blueprint with citations, and the limitations.

**2. Run the agent yourself (access code).** On the home page enter one access code:
[JUDGE_CODE_1] · [JUDGE_CODE_2] · [JUDGE_CODE_3] · [JUDGE_CODE_4]. Each code allows three full
workflows until [CODE_EXPIRY] and has its own spending cap. Then:

1. Create a café project and write a brief with two or three interests, such as a film and a
   musician.
2. Interpret the brief, then confirm it.
3. Pick the intended entities if asked, then generate hypotheses from the collision pool.
4. Open a claim's evidence, then compose a blueprint.

Each stage takes from a few seconds to about a minute; the activity panel shows progress. If an
interest pair yields too few cross-world bridges, the app says so and suggests adding a third
interest. If another judge's run is in progress, you may see "The studio is busy": try again
shortly.

**3. Reproduce locally (no keys).** See the repository README quick start; synthetic data is
labelled "FIXTURE — not real Qloo data".

## Tools and attribution

- **Cultural data:** Qloo (Insights API through the official Qloo Harness).
- **AI agents:** Anthropic Claude: Claude Sonnet 5.5 via the Claude API in deployment, and the
  official Claude Agent SDK on the developer's own Claude subscription for local development
  only.
- **Development:** assisted by Claude Code and Codex. All code is the entrant's project and is
  MIT licensed; dependencies keep their own licenses.

## Rules compliance check (official rules, read 2026-10-26)

| Requirement | How Tessaloom meets it | Status |
| --- | --- | --- |
| Working app integrating the Qloo API as an agentic tool | Qloo Harness workflows drive resolution, discovery and every claim test inside a multi-role Claude agent loop | Verified locally with live Qloo + Claude; production run pending |
| Link to a **functional demo application** | Public `code.run` URL | **Blocked**: port `p01` is private until approved |
| Judges can test it free of charge until judging ends (Nov 2–5); credentials in testing instructions if access is restricted | A read-only story sample needs no code. **Interactive** runs need a capped access code, which goes in Devpost's testing instructions. The story alone is **not** enough: judges must be able to run the agent themselves | **Prepared**: needs the paid acceptance run, then judge grants with a judging budget |
| Public repository with a detectable open-source license in the About section | MIT `LICENSE`; GitHub already detects MIT (repository currently private) | **Pending owner**: make public, then check the About section |
| English text description | README and this draft | Ready, with placeholders for production results |
| Third-party APIs used within their terms | Anthropic API key (Commercial Terms) for public inference; the personal subscription is local-only and refused in production; Qloo data stays server-side, not in the repo | Verified in code and docs |
| Original work; open-source dependencies respected | License inventory in [PUBLIC_READINESS.md](PUBLIC_READINESS.md) | Ready |
| Video | Optional; script in [DEMO_SCRIPT.md](DEMO_SCRIPT.md) | Optional |

## Owner-only fields and final actions

- After the final acceptance run: fill [PUBLIC_URL], [RUN_DATE], [PRODUCTION_RESULT] and the access code(s), and add the public repository URL.
- Gallery: up to five screenshots from [DEMO_SCRIPT.md](DEMO_SCRIPT.md). Real-data screenshots are fine on Devpost but never in the repository ([rights review](DATA_RIGHTS_REVIEW.md)). A video is optional under the rules.
- Confirm eligibility and the current Devpost form personally; review the AI-assistance disclosure (Claude Code and Codex).
- Submit before **October 30, 2026, 11:45 PM ET** (October 31, 11:45 AM Beijing). Judging runs November 2–5.
