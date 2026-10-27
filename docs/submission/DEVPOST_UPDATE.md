# Devpost edits before Oct 30, 11:45 PM EDT (copy-paste)

The project is already submitted; **edit it, do not resubmit**. This matches what is deployed
since 2026-10-27 07:26 UTC ([rollout evidence](../evidence/rollout-demo-b-gemini-2026-10-27.md)):
- the public demo runs **real Gemini 3.8 Flash**;
- on a **clearly labelled synthetic (fictional) Qloo transport**;
- with open access and a $1/day cap.

Change only the fields below; everything else in [DEVPOST.md](DEVPOST.md) stays accurate. If
the demo is rolled back to the $0 scripted mode, see the note at the end.

## Short description (replace)

> Tessaloom helps small venues turn cross-cultural inspiration into evidence-aware event plans.
> AI agents use Qloo as their tool to find connections between cultural worlds, propose
> hypotheses, test every claim against Qloo results with fixed rules, and compose an editable
> blueprint in which each statement is labelled as Qloo evidence, AI interpretation or creative
> speculation. The public demo runs the full agent on Gemini 3.8 Flash with clearly labelled
> fictional cultural data.

## "How the Claude agents operate": retitle to "How the agents operate", and replace the first sentence

> Six roles run inside a recoverable state machine on a pg-boss worker; five of them call a
> language model through one provider-agnostic gateway. The public demo uses Google Gemini 3.8
> Flash; the verified real-data run used Claude Sonnet 5.5.

## Testing and experimental results: replace the "Production run" bullet

> - **Public demo (Gemini 3.8 Flash, synthetic data).** The hosted site runs the full workflow
>   on Gemini 3.8 Flash over a synthetic Qloo transport. Titles and signals are fictional, and
>   every item is labelled "FIXTURE — not Qloo data".
>   - A measured complete workflow (brief → blueprint): 5 model calls, 95 s, $0.044, every
>     output schema-valid.
>   - One blueprint draft invented unsupported numbers; the semantic validator rejected it, and
>     the single allowed repair fixed it.
>   - Live Qloo data is not used on the public site, because Qloo has not yet confirmed that its
>     results may be sent to a third-party AI model or displayed publicly. The real-data run
>     above was made locally, with the developer's own access.

## Known limitations: replace the "Agent runs are invitation-only…" bullet

> - The public demo uses fictional cultural data (labelled throughout) instead of live Qloo
>   results until Qloo confirms display and AI-processing rights. The live Qloo path is
>   implemented and was verified locally on 2026-10-26.
> - Public AI runs are capped at $1 per day. When the cap is reached, the site asks visitors to
>   try again later. Each run also has fixed limits on Qloo calls, model calls and time; a run
>   that reaches one stops with its results kept and says which limit applied.

## Built with (replace)

> TypeScript, Next.js, React, Tailwind CSS, React Flow, PostgreSQL, Drizzle ORM, pg-boss, Zod,
> Qloo Insights API (Qloo Harness), Google Gemini API (Gemini 3.8 Flash), Claude Agent SDK
> (verified real-data run, local), Vitest, Playwright, axe-core, Docker, Northflank.

## Tools and attribution: replace the "AI agents" bullet

> - **AI agents:** a provider-agnostic gateway. The public demo uses Google Gemini 3.8 Flash
>   (paid API) on synthetic data only. The local real-data run used Claude Sonnet 5.5 through
>   the official Claude Agent SDK on the developer's own subscription.

## Testing instructions (replace the whole field)

> **Run the AI agent on the public demo (no code, no sign-up, no cost to you).**
> https://p01--tessaloom--mpfcqkyl42yb.code.run
>
> The red banner says the cultural data is fictional ("FIXTURE — not real Qloo data"). The AI
> steps run live on Gemini 3.8 Flash.
>
> 1. **Start a new project** → enter a name → **Create project**.
> 2. Click **Use the fixture example**, or type 2–6 interests of your own.
> 3. **Interpret brief** (about 10 s) → **Confirm & discover** → **Open the Discovery canvas**:
>    about 200 cross-world bridges and a scored collision pool.
> 4. **Generate hypotheses with this pool** → open **Hypotheses** (about 30–90 s; the "Decisions
>    & actions" panel shows each step). Use **Inspect evidence** to see each claim, the fixed
>    rule that graded it, and its trace.
> 5. **Select** a hypothesis → **Compose blueprint**. If the loop finished at a run limit
>    instead, use **Compose a blueprint** and tick a hypothesis.
> 6. Read the blueprint. Each block is labelled evidence-backed, AI interpretation, or creative
>    speculation, and the citations resolve to the evidence appendix. You can export, print or
>    share it read-only.
> 7. Optional: **What-if** → change a weight or seed and compare.
>
> If you see "The studio is busy" or a daily-limit message, wait a minute (or until the next UTC
> day) and retry. Live Qloo data is not shown publicly until Qloo confirms display and
> AI-processing rights. Its integration is in the repository and was verified locally (README →
> Status).

## Gallery (replace the images)

Upload the screenshots from the **live public site**, captured on 2026-10-27 (real Gemini 3.8
Flash, fictional data only, labelled "FIXTURE"), in `test-results/public-final/`:

| File | Caption |
| --- | --- |
| `1-intent.png` | Gemini interprets the venue brief into cultural worlds and asks about anything ambiguous before searching. |
| `2-discovery.png` | Discovery threads each interest into other worlds; items reached from more than one interest become cross-world bridges, scored for relevance, novelty and tension. |
| `3-hypotheses.png` | Competing hypotheses written by the agent; every claim is graded by fixed rules, and a critic flags weak pairings. |
| `4-evidence.png` | The evidence drawer: each claim, the rule that graded it, the values behind it, and a trace. |
| `5-blueprint.png` | The composed blueprint, "Quiet Hearth Nocturne at Harbor Lights", with its traceability meter and all four citations resolving. |
| `7-shared-read-only.png` | The read-only shared view with an expiry date, which anyone can open without an account. |

Do **not** upload the earlier real-data screenshots or the two videos: they show Qloo-derived
names, and display permission is pending. The video field is optional; leave it empty.

## If the demo is rolled back to Demo A ($0 scripted)

Replace "Gemini 3.8 Flash" in the testing instructions and short description with: "scripted
stand-ins (the banner says no language model is called)". Remove Gemini from "Built with".
