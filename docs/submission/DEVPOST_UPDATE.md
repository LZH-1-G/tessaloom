# Devpost edits before Oct 30, 11:45 PM EDT (copy-paste)

The project is already submitted; **edit it, do not resubmit**. Change only the fields below.
Everything else in [DEVPOST.md](DEVPOST.md) stays accurate.

Pick the variant that matches what is actually deployed ([DEMO_DEPLOYMENT.md](DEMO_DEPLOYMENT.md)):
- **Demo A:** synthetic data with scripted AI, $0.
- **Demo B:** synthetic data with Gemini 3.8 Flash.

Until one of them is live, use the **closed** variant.

## Short description (replace)

> Tessaloom helps small venues turn cross-cultural inspiration into evidence-aware event plans.
> AI agents use Qloo as their tool to find connections between cultural worlds, propose
> hypotheses, test every claim against Qloo results with fixed rules, and compose an editable
> blueprint in which each statement is labelled as Qloo evidence, AI interpretation or creative
> speculation. The public demo runs the same workflow on clearly labelled fictional data.

## "How the Claude agents operate": retitle to "How the agents operate", and replace the first sentence

> Six roles run inside a recoverable state machine on a pg-boss worker; five of them call a
> language model through one provider-agnostic gateway. The verified real-data run used Claude
> Sonnet 5.5. The public demo uses **[A]** deterministic scripted stand-ins, so no model is
> called, or **[B]** Gemini 3.8 Flash.

## Testing and experimental results: replace the "Production run" bullet

> - **Public demo.** The hosted site runs the full workflow on a synthetic Qloo transport. Titles
>   and signals are fictional and every item is labelled "FIXTURE — not Qloo data". **[A]** AI
>   steps use scripted stand-ins, and the banner says no language model is called. **[B]** AI
>   steps use Gemini 3.8 Flash on that synthetic data only.
>   - Live Qloo data is not used on the public site, because Qloo has not yet confirmed that its
>     results may be sent to a third-party AI model or displayed publicly.
>   - The real-data run above was made locally, with the developer's own access.

## Known limitations: replace the "Agent runs are invitation-only…" bullet

> - The public demo uses fictional cultural data (labelled throughout) instead of live Qloo
>   results until Qloo confirms display and AI-processing rights. The live Qloo path is
>   implemented and was verified locally on 2026-10-26.
> - **[A]** The public demo's AI steps are scripted stand-ins, which is why their wording is
>   formulaic. **[B]** Public AI runs are capped at $2 per day; when the cap is reached, the site
>   asks visitors to try again later.

## Built with (replace)

> TypeScript, Next.js, React, Tailwind CSS, React Flow, PostgreSQL, Drizzle ORM, pg-boss, Zod,
> Qloo Insights API (Qloo Harness), Claude Agent SDK (verified real-data run, local), **[B only:]**
> Google Gemini API (Gemini 3.8 Flash), Vitest, Playwright, axe-core, Docker, Northflank.

## Tools and attribution: replace the "AI agents" bullet

> - **AI agents:** a provider-agnostic gateway. Claude Sonnet 5.5 through the official Claude
>   Agent SDK on the developer's own subscription, for the local real-data run only.
>   **[B:]** Google Gemini 3.8 Flash (paid API) for the public demo, on synthetic data only.
>   **[A:]** The public demo uses scripted stand-ins and calls no model.

## Testing instructions (replace the whole field)

> **Run the agent on the public demo (no code, no sign-up, no cost to you).**
> https://p01--tessaloom--mpfcqkyl42yb.code.run
>
> The red banner says the data is fictional ("FIXTURE — not real Qloo data"). **[A:]** It also
> says no language model is called.
>
> 1. **Start a new project** → enter a name → **Create project**.
> 2. Click **Use the fixture example**, or type 2–6 interests of your own.
> 3. **Interpret brief** → **Confirm & discover** → **Open the Discovery canvas**: about 200
>    cross-world bridges and a scored collision pool.
> 4. **Generate hypotheses with this pool** → open **Hypotheses**. Use **Inspect evidence** to
>    see each claim, the fixed rule that graded it, and its trace.
> 5. **Select** a hypothesis → **Compose blueprint**. Each block is labelled evidence-backed, AI
>    interpretation, or creative speculation, and the citations resolve to the evidence
>    appendix. You can export, print or share it read-only.
> 6. Optional: **What-if** → change a weight or seed and compare.
>
> Each step takes seconds **[B: up to about a minute]**. If you see "The studio is busy", wait a
> minute and retry. Live Qloo data is not shown publicly until Qloo confirms display and
> AI-processing rights. Its integration is in the repository and was verified locally (README →
> Status). To run locally without keys, follow the README quick start.

**Closed variant** (only if no demo is deployed by Oct 30; this does **not** meet the
working-demo rule):

> The public site shows the studio, but AI runs are switched off while Qloo data-permission
> questions are pending. Run the complete workflow locally without keys by following the README
> quick start; it uses labelled synthetic data.

## Gallery (replace the images)

Upload the synthetic-demo screenshots from `test-results/devpost-screenshots/` (1440 × 900).
They show only fictional data and are labelled "FIXTURE"; the Demo A banner is visible:

| File | Caption |
| --- | --- |
| `1-studio-home.png` | The studio: describe a venue and the cultures you love. This public demo uses clearly labelled fictional data. |
| `2-brief.png` | A brief with three interests from different worlds: a game, an illustrated travel book and a film. |
| `3-discovery-collision-pool.png` | Discovery threads each interest into other worlds; items reached from more than one interest become bridges, scored for relevance, novelty and tension. |
| `4-hypothesis-lab.png` | Competing hypotheses, each with testable claims graded by fixed rules: supports, contradicts, neutral or insufficient. |
| `5-evidence.png` | The evidence drawer: each claim, the rule that graded it, the values behind it, and a trace. A critic adds interpretation but cannot change a stance. |
| `6-blueprint.png` | The blueprint with its traceability meter: evidence-backed, AI interpretation and speculation, with every citation resolving. |
| `7-blueprint-evidence-appendix.png` | The evidence appendix behind every citation, with its origin labelled. |

**Do not upload** the earlier real-data screenshots or the two videos (`tessaloom-demo.mp4`,
`tessaloom-mobile-story.mp4`): they show Qloo-derived names, and display permission is pending.
A video is optional under the rules; leave the video field empty, or record a new one from the
synthetic demo.

## Before saving on Devpost

- Replace each **[A]** or **[B]** marker with the deployed variant, and delete the other.
- Open the demo URL in a private window and follow your own testing instructions once.
