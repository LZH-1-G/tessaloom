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

## How we built it

The application uses TypeScript, Next.js, React, PostgreSQL, Drizzle and pg-boss. A persistent worker executes a recoverable state machine with six specialized roles: intent analysis, cultural discovery, hypothesis generation, evidence criticism, counterfactual explanation and blueprint composition. Human confirmation gates control important transitions. Typed evidence plans and deterministic evaluators constrain what an LLM can claim.

Qloo integration uses the official Harness through supported workflows and typed adapters. Search and entity resolution establish the intended cultural inputs; recommendations, rankings, tags and audience comparisons supply evidence for cross-domain claims. The adapter normalizes different response shapes, records provenance, separates cache reuse from retrieval, and enforces bounded requests. Unsupported or inadequate evidence remains insufficient rather than being converted into a confident conclusion.

A provider-independent LLM Gateway runs the agent roles on Claude (Claude Sonnet 5.5 through the Anthropic API in deployment), and also supports DeepSeek, Gemini and scripted AI. Strict schemas and semantic checks validate responses. Paid requests require access authorization and global spending reservations; DeepSeek additionally requires explicit CNY limits and conservative currency accounting. Web and worker processes use separate identities, and provider credentials stay outside the browser and web process.

## What makes it original

The contribution is the complete creative hypothesis loop, not simply combining two recommendation lists. A cultural connection becomes a testable claim, enters an inspectable evidence graph, survives a controlled counterfactual comparison, and becomes a practical blueprint whose assumptions remain visible. Dependency-aware reuse makes the experiment cheaper and more explainable at the same time.

## Challenges and what we learned

Provider responses do not always match a convenient product abstraction. Audience profiles are not similarity percentages, affinity is not probability, and absent results do not prove an audience relationship is impossible. We designed deterministic evaluators and uncertainty labels around those limits.

We also found that a cache timestamp can accidentally imply fresh evidence. Preserving original snapshots and retrieval dates across database views and What-if branches was essential to making the graph trustworthy.

## Validation and current limitations

Historical live Qloo checks verified supported Harness capabilities, with limitations documented in the repository. Separately, exactly two authorized DeepSeek V4 Pro calls using invented cultural inputs passed strict JSON/schema and semantic validation. These are distinct tests: a full real-Qloo-to-DeepSeek application run has not been validated. On 2026-10-26 the complete application workflow (brief, entity selection, live Qloo discovery and evidence, hypotheses, blueprint) ran locally with live Qloo data and Claude Sonnet, through the official Claude Agent SDK on the developer's own Claude subscription (local personal use, no API charge). All five model calls passed validation, and all seven blueprint citations resolve to stored live-Qloo evidence. The public deployment's Claude API path has not yet been exercised with real calls.

A separate local demonstration mode uses synthetic cultural data and scripted AI, prominently labelled “FIXTURE — not real Qloo data.” It demonstrates the actual database, agent orchestration, graph, branching and composition behavior without consuming provider quota. Read-only samples use the same stored outputs. They are not evidence of real cultural affinity or commercial demand.

Current event quota and credential expiry remain unverified. Raw Qloo responses are not retained. Live generation stays invitation-only behind spending caps. No causal, attendance or sales guarantee is made.

## What's next

Complete a separately authorized, tightly bounded live calibration when quota and data-use prerequisites are established, measure quality across more briefs, and refine evaluator thresholds using genuine provider responses. The existing uncertainty and provenance safeguards remain part of that work.

## Built with

TypeScript, Next.js, React, Tailwind CSS, React Flow, PostgreSQL, Drizzle ORM, pg-boss, Zod, Qloo Harness, Claude (Anthropic API), Claude Agent SDK (local development), DeepSeek, Vitest, Playwright, axe-core, Docker, Caddy.

## Testing instructions

> Fill the bracketed values only after the approved production first run
> ([runbook](PRODUCTION_FIRST_RUN.md)) has succeeded. Until then, keep this section out of Devpost.

**Public read-only result (no sign-in, no cost):** open [PUBLIC_URL], choose **Demo samples**, then
open **Spirited sound evenings**. It is a real run from [RUN_DATE]: live Qloo data for *Spirited
Away* and Joe Hisaishi, hypotheses tested against Qloo evidence, and a blueprint whose citations
open the stored evidence. Use **Traceability** to filter speculative blocks, and the evidence
appendix to see each claim's stance, rule and retrieval date.

**Live generation (optional, private code):** enter the access code given in the private testing
field, create a café project, add two cultural interests, and follow Brief → Discovery → Hypotheses
→ Blueprint. Each code has a fixed expiry, run count and spending cap. Runs take a few minutes; a
code that is used up or expired is refused with an explanation.

**Local demonstration (no keys):** follow the repository quick start, create a project and choose
“Use the fixture example.” Every synthetic stage is labelled “FIXTURE — not real Qloo data.”

## Owner-only fields and final actions

- Run the approved production first run, feature its blueprint as a sample, then insert the actual public demo URL, run date and public repository URL; none exist yet.
- Confirm the current Devpost form, eligibility, attribution and open-source requirements personally.
- Upload the reviewed fixture-labelled screenshots; a short narrated video is optional under the previously owner-verified rules, subject to the current form.
- Confirm that the offered demo satisfies the event's meaningful-Qloo-integration and public-working-demo requirements. A fixture demonstration alone must not be represented as live Qloo validation.
- Review AI-assistance disclosure and then submit before October 31, 2026, 11:45 AM Beijing time. No organizer inquiry is required for the independent preparation tasks above.
