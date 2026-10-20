# Tessaloom — Originality Strategy and Prior-Art Considerations

> **Status:** v1.1 · 2026-10-20 (review: §5 mapped to the four official judging criteria)
> **Purpose:** Explain where Tessaloom's innovation comes from, document a reasonable prior-art review and its limits, and define the process that keeps the implementation independent.
> **Important:** The five systems below are **original product concepts, engineered independently**. They are not claims that any individual algorithm is unprecedented. Several building blocks (MMR diversification, Jaccard similarity, rank-biased overlap, state machines) are well-known techniques, credited as such.

---

## 1. Originality thesis

Most cultural-AI products ask: *"Given what someone likes, what else will they like?"* The answer is a list, often with an LLM explanation on top.

Tessaloom asks a different question: ***"What new cultural experience could emerge when these worlds meet — and how strong is the evidence for it?"***

The innovation lies in the **experimental mechanism**, not in the data source or the interface style:

| Conventional pattern | Tessaloom pattern |
|---|---|
| Input: user preferences | Input: a **creative challenge** with several cultural interests and real venue constraints |
| Output: ranked recommendations | Output: **hypotheses** with testable claims, graded by evidence |
| LLM writes explanations after retrieval | LLM **proposes**, deterministic evaluators **grade**, and the LLM critic can only **downgrade** |
| Changing input means asking again | Changing input creates a **counterfactual branch** that recomputes only the affected evidence, with a quantitative diff |
| Provenance implicit or absent | **Six provenance classes**, enforced by the database and shown in the design |
| Output ends at an answer | Output is an **experience blueprint** whose every block is cited or labeled speculative |

---

## 2. The five original systems

### A. Cultural Collision Engine

- **What it does.** It builds cross-domain "threads" from Qloo recommendations for each confirmed seed. It then finds *bridges* (shared tags, co-occurrence) and scores candidate collisions on relevance, novelty, and fit to a user-chosen **collision tension**. Finally it selects a diverse pool with Maximal Marginal Relevance.
- **What is original here.** The *tension-targeting* formulation, `tensionFit = 1 − |novelty − τ|`, lets a creator dial between harmonious and unexpected combinations. Under the hood, the creative risk appetite becomes an explicit, inspectable parameter that feeds a counterfactual. The pool is the **only** material the hypothesis generator may use, so creativity is grounded by construction.
- **Known building blocks credited:** MMR diversification (Carbonell & Goldstein, 1998); Jaccard similarity; the general notions of *combinational creativity* (Margaret Boden) and *conceptual blending* (Fauconnier & Turner) as design inspiration, not as implemented formal models.

### B. Creative Hypothesis Loop

- **What it does.** Generate → plan evidence → collect → grade deterministically → critique → revise, retire, or spawn → terminate on convergence, diminishing returns, the iteration limit, or the budget.
- **What is original here.** The application of a *scientific hypothesis cycle* to **cultural programming design**, with:
  - typed claim **test kinds** that map creative assertions to specific Qloo capabilities;
  - an **asymmetric authority rule**: deterministic evaluators set stances, and the LLM critic can only add interpretation or downgrade;
  - **honest negative results**: contradicted hypotheses remain visible.
- **Known building blocks credited:** propose-and-verify agent loops are an established pattern in agent research. The state-machine orchestration is a conventional engineering technique.

### C. Counterfactual Experimentation Engine

- **What it does.** A variable delta produces a rebuilt query plan. The query `requestHash` diff yields the **dirty set**. Only dirty queries are re-executed live; claims are re-evaluated; parent and branch are compared with overlap@K, RBO, entered/exited entities, stance and status changes, and score deltas.
- **What is original here.** The **hold-hypotheses-fixed** default makes the comparison a genuine counterfactual: the same ideas tested under changed cultural conditions. In addition, a **genuineness report** (dirty/reused/new results) proves that the changes come from retrieved data. When no data changed, the UI says so explicitly. The LLM narrative may only describe computed metrics (numeric fidelity validation).
- **Known building blocks credited:** rank-biased overlap (Webber, Moffat & Zobel, 2010); dependency-aware incremental recomputation is a classic build-system idea.

### D. Cultural Evidence Graph

- **What it does.** An interactive graph of entities, tags, hypotheses, claims, evidence, and experiments, with **provenance as a visual dimension**: shape, border, icon, and label for Qloo data, computed, AI interpretation, creative speculation, user, and fixture.
- **What is original here.** A graph that **separates data from interpretation from imagination** at the node and edge level, with a request-to-result trace on every Qloo-sourced fact, and with branches overlaid on their parents.
- **Known building blocks credited:** provenance modeling concepts resemble W3C PROV (entity/activity/agent). Tessaloom uses its own simplified classes, not the PROV standard. Graph rendering uses React Flow.

### E. Explainable Experience Synthesis

- **What it does.** It composes a blueprint (concept, audience, programming, atmosphere, partners, promotion, logistics, constraints/risks, measurement) from selected hypotheses. Every block carries a provenance class and evidence citations. A traceability validator and meter quantify how much of the plan is evidence-backed.
- **What is original here.** **Traceability as a product metric** shown to the user ("62% Qloo-backed"), plus practical constraint extraction tied to evidence. The result is an *auditable creative plan*, not an inspirational text.

---

## 3. Prior-art and similarity review

### 3.1 Method and limits

- **Searches performed (2026-10-20):** web searches for Qloo hackathon entries and related cultural-AI projects; an attempted fetch of the 2025 Qloo LLM Hackathon project gallery and of the 2026 event page.
- **Limits:**
  - The Devpost galleries and rules pages returned **HTTP 403 / Cloudflare challenges**, and we did not bypass them. **The review is therefore incomplete.**
  - For the projects listed below, we saw only search-result summaries. **We did not read, clone, or inspect their source code, designs, or videos.** This is deliberate (clean-room posture) and also a limitation.
  - We cannot confirm which projects won or what their full feature sets are.

### 3.2 Projects identified (summary level only)

| Project (as described in search summaries) | Apparent focus | Similarity to Tessaloom | Key difference |
|---|---|---|---|
| CultureHub (Devpost, 2025 Qloo LLM Hackathon) | Privacy-first cultural recommendations across several use cases, Streamlit + Gemini | Uses Qloo for cultural recommendations | Recommendation-centric. No hypothesis testing, counterfactual branching, or provenance-graded blueprint. |
| Wanderlust (Devpost) | AI travel planner mapping interests to Qloo tags for itineraries | Interest → Qloo tags | Travel itineraries for individuals vs. experiments for venues; no evidence grading |
| Appmuseme (GitHub, 2025 entry) | Travel planner combining Qloo and Gemini | Qloo + LLM | Same distinction as above |
| Taste Concierge (GitHub) | Agentic outing planner chaining Qloo tool calls | Agentic tool chaining | Plans outings for a person; no hypothesis/claim/evidence model, no counterfactual engine |
| TasteLoop Agent (GitHub, labeled for the 2026 Agentic Hackathon) | Weekly planner explaining picks, with a generic-baseline comparison | Explains why; has a comparison idea | Personal planner vs. a venue experimentation studio. Its comparison is against a generic baseline, while ours is a dependency-aware counterfactual recomputation between experiment branches. |
| qloo-mcp + "Taste Match" (GitHub) | Qloo as MCP tools; audience-finding for independent artists | MCP tool usage; audience focus | An infrastructure/tooling focus; no creative hypothesis lifecycle |
| Dev-angPatil/qloo-agentic-hackathon (GitHub) | Repository named for the 2026 event; details unknown | Same event | Unknown. **Not inspected.** |

### 3.3 Conceptual prior art

| Concept | Relationship |
|---|---|
| Recommender systems with LLM explanation | The pattern Tessaloom explicitly moves away from |
| Conceptual blending / combinational creativity | Inspiration for "collisions". We do not claim to implement these theories formally. |
| Hypothesis-driven "AI scientist"-style agents | A similar loop shape in a different domain. Our contribution is the domain mapping, typed claim tests over cultural data, and the asymmetric authority rule. |
| What-if / scenario analysis tools (BI, simulation) | Similar intent. Our differences are recomputation over *cultural affinity data* with genuineness reporting. |
| Provenance standards (W3C PROV) and argument mapping | Similar goals for traceability. Our differences are the user-facing provenance classes integrated into a creative workflow. |

### 3.4 Conclusion of the review

Within the limits above, we found **no project that combines** (1) creative-challenge input for venues, (2) evidence-graded hypotheses with typed claim tests over Qloo data, (3) dependency-aware counterfactual branches with genuineness reporting, (4) a provenance-class evidence graph, and (5) a traceability-scored blueprint. Individual elements (Qloo plus an LLM, agentic tool chaining, explanations, comparisons) clearly exist elsewhere. **Tessaloom's originality claim is about this integrated experimental mechanism, not about any single element.**

---

## 4. Clean-room and independence practices

1. **No code reuse from other entries.** We will not open or copy source code, UI layouts, prompts, or assets from other hackathon projects during the event. Third-party dependencies are open-source libraries with compatible licenses, recorded in `package.json` and audited.
2. **The official kit is used as intended.** We use the `@qloo/qloo-harness` package and follow the kit's documented patterns, for example spawning `qloo mcp` with `env: process.env`. Any small snippet adapted from the kit's MIT-licensed starter will be attributed in code comments.
3. **Original visual identity.** The "Loom" design system, color tokens, typography pairing, and provenance visual language are created for this project ([UI_UX_SPEC.md §2](UI_UX_SPEC.md#2-visual-identity)).
4. **Original prompts.** Prompt templates are written from this project's role contracts and versioned in the repository.
5. **Decision log.** Significant design choices are recorded in [DECISIONS.md](DECISIONS.md) with dates, which provides an auditable trail of independent development.
6. **AI-assistant hygiene.** Claude Code and Codex are instructed via this documentation and per-milestone briefs. Generated code is reviewed, and assistants are not asked to reproduce other projects.

---

## 5. How originality is demonstrated to judges

The official judging criteria are **four, equally weighted**: Technological Implementation, Design, Potential Impact, and Quality of the Idea. These were externally verified by the owner against the official Devpost rules (HACKATHON_CHECKLIST §1.1).

| Official criterion (25% each) | Demonstration in Tessaloom | Supporting qualities the kit also highlights |
|---|---|---|
| **Quality of the Idea** | Creative ideas treated as testable hypotheses; hold-fixed counterfactuals with genuineness reporting; traceability as a product metric (§2 A–E) | — |
| **Technological Implementation** | A state machine with budgets and recovery; deterministic evaluators; dependency-aware recomputation over Qloo data via the official harness; deterministic experiment keys and replay; test suite and CI | Reproducibility; provenance |
| **Design** | The "Loom" visual identity; the provenance visual language (shape + label, not color alone); Discovery Canvas lanes; Hypothesis Lab cards; the What-if comparison view; a 3-minute onboarding; WCAG 2.2 AA | User clarity |
| **Potential Impact** | Independent venues get an evidence-backed, exportable plan in minutes; the generic domain model extends to other cultural programming use cases | Usefulness; responsible data handling (no personal data, aggregate-only language) |

---

## 6. Risks to the originality claim

| Risk | Mitigation |
|---|---|
| The product is perceived as "another recommender with AI" | Open the demo on the Hypothesis Lab and the What-if comparison, not on search. Use "hypothesis", "evidence", and "experiment" language throughout. |
| Another entry has a similar counterfactual idea | Our differentiation rests on **genuineness reporting** and **hold-fixed counterfactuals** over typed claims. Document this clearly in the submission. |
| Live Qloo capabilities are narrower than planned (🟡) | Test kinds degrade individually to INSUFFICIENT with an explanation. The mechanism remains intact and honest even with fewer test kinds. |
