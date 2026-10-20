# Tessaloom — UI/UX Specification

> **Status:** Design baseline v1.1 · 2026-10-20 (review: "Design" is one of four equally weighted judging criteria, externally verified; audience-band control added)
> **Stack:** Next.js App Router · React · Tailwind CSS · shadcn/ui (Radix) · React Flow (`@xyflow/react`) · Recharts
> **Related:** [PRD.md](PRD.md) · [API_CONTRACTS.md](API_CONTRACTS.md) · [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md)

---

## 1. Experience principles

1. **A studio, not a chatbot.** The primary interactions are structured forms, canvases, cards, inspectors, and comparison tools. There is no chat input as the main control.
2. **Show the loom working.** Agent progress is always visible (activity dock), concise, and controllable.
3. **Provenance is part of the design.** Every fact wears its origin. A user should never wonder whether something came from Qloo or from the model.
4. **Experiments are first-class.** Branching, comparing, and revisiting are one click away from wherever the user is.
5. **Value in three minutes.** A sample project shows the full loop immediately, with no sign-up and no waiting.
6. **Design is judged.** "Design" is one of the four equally weighted judging criteria ([HACKATHON_CHECKLIST.md §2.7](HACKATHON_CHECKLIST.md#27-judging-criteria-four-equally-weighted-externally-verified-f9)). Visual polish of the core pages (Dashboard, Hypothesis Lab, What-if Lab, Blueprint) is required work, not stretch.

---

## 2. Visual identity

### 2.1 Concept: "The Loom"

The brand metaphor is weaving:

- **Warp threads** are cultural domains (vertical, steady).
- **Weft threads** are hypotheses that cross them (horizontal, creative).
- **Knots** are evidence.

This metaphor appears in the logo, section dividers, the Discovery Canvas layout (domain lanes), and loading animations (a shuttle crossing threads). Tessaloom deliberately avoids the visual language of generic AI dashboards, such as purple gradients and sparkle icons, and avoids chat bubbles.

### 2.2 Design tokens (CSS variables, light and dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--tl-bg` | `#F6F1E7` (linen) | `#14161C` (night loom) | Page background |
| `--tl-surface` | `#FFFDF8` | `#1C1F27` | Cards, panels |
| `--tl-ink` | `#1E2233` (indigo ink) | `#ECE6D9` | Primary text |
| `--tl-muted` | `#5D6275` | `#A3A8B8` | Secondary text |
| `--tl-warp` | `#2F3E8F` (indigo) | `#8C9BF2` | Primary actions, domain lanes |
| `--tl-weft` | `#C2562B` (madder) | `#F08A5D` | Hypotheses, highlights |
| `--tl-saffron` | `#D9A21B` | `#F2C14E` | Attention, pending states |
| `--tl-moss` | `#3E7C4F` | `#79C08E` | Supported |
| `--tl-rust` | `#A63D40` | `#E57C7F` | Contradicted, errors |
| `--tl-slate` | `#6B7280` | `#9CA3AF` | Inconclusive, neutral |

All text and background pairs must reach a WCAG AA contrast ratio (4.5:1 for body text, 3:1 for large text and UI components). This is verified by an automated contrast test (TEST_PLAN §10).

### 2.3 Typography

- **Display:** *Fraunces* (variable serif) for page titles and hypothesis titles. It gives an editorial, crafted feel.
- **Text and UI:** *Inter* (variable).
- **Data and provenance chips:** *IBM Plex Mono* for IDs, scores, and request traces.

All fonts are loaded via `next/font` (self-hosted at build time, no runtime third-party requests).

### 2.4 Provenance visual language (core design system element)

| Provenance class | Chip label | Icon (Lucide) | Node and card border | Pattern |
|---|---|---|---|---|
| `QLOO_SOURCED` | **Qloo data** | `database` | Solid 2 px, indigo | Solid fill tint |
| `APP_DERIVED` | **Computed** | `sigma` | Solid 1 px, ink | Thin diagonal hatch |
| `MODEL_INTERPRETATION` | **AI interpretation** | `message-square-quote` | Dashed 2 px, madder | None |
| `CREATIVE_SPECULATION` | **Creative speculation** | `sparkle` *(outline)* | Dotted 2 px, saffron | Dotted background |
| `USER_PROVIDED` | **You** | `user-round` | Solid 1 px, muted | None |
| `DEVELOPMENT_FIXTURE` | **FIXTURE — not Qloo data** | `flask-conical` | Double 3 px, rust | Repeating "FIXTURE" watermark |

Data-origin sub-badges for Qloo data: `LIVE` · `CACHED <age>` · `RECORDED <date>`.

**Rule:** Every chip has visible text. Color is never the only signal. Screen readers announce the chip label, for example "Qloo data, recorded 2026-10-26".

---

## 3. Information architecture and global layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Top bar: Tessaloom logo · Project switcher · Mode badge (LIVE/REPLAY/    │
│          FIXTURE) · Qloo status dot · Share · Help (?)                   │
├───────────┬──────────────────────────────────────────────┬───────────────┤
│ Project   │                                              │ Activity dock │
│ rail      │            Page content                      │ (collapsible, │
│ ───────── │                                              │  360 px)      │
│ 1 Brief   │                                              │ • state       │
│ 2 Discover│                                              │ • timeline    │
│ 3 Hypoth. │                                              │ • budgets     │
│ 4 What-if │                                              │ • controls    │
│ 5 Blueprnt│                                              │               │
│ History   │                                              │               │
└───────────┴──────────────────────────────────────────────┴───────────────┘
```

- **Project rail.** Shows the experiment workflow as a numbered "pattern" with a completion state per step. Steps that are not yet reachable are disabled and explain why, for example "Run discovery first".
- **Experiment selector.** In the page header, a breadcrumb shows `Root experiment › Branch "Porto instead of Lisbon"`, with a branch-tree popover.
- **Breakpoints:**
  - ≥ 1280 px: three columns.
  - 768–1279 px: the dock becomes a bottom sheet.
  - < 768 px: the rail becomes a top segmented control, the dock is a floating button with a sheet, and the graph defaults to list view.

---

## 4. Page specifications

### 4.1 Home Dashboard — `/`

**Purpose.** Orient first-time visitors, especially judges, and give returning users quick access.

| Region | Content |
|---|---|
| Hero (first visit only; dismissible, remembered via localStorage) | A one-sentence value statement, a 3-step illustrated explainer (Brief → Hypotheses tested with Qloo → What-if & Blueprint), and two CTAs: **Explore a sample experiment** (primary) and **Start a new project** |
| Sample experiments | Three cards (the scenarios from PRD §9), each with mode badge `REPLAY · Qloo data recorded <date>`, the hypothesis count, and a "branches" count. Clicking one forks it into the workspace and opens the Hypothesis Lab. |
| Your projects | A grid or list of project cards: name, use case, last activity, latest experiment status, a hypothesis status mini-bar (counts by status). Sortable by recent. |
| Active runs | A strip of currently running or paused runs with a "needs your input" badge |
| System status | A small card: Qloo adapter ready? LLM available? Daily live-run allowance remaining |

**States:**

- **Empty:** sample cards plus "Your experiments will appear here."
- **Quota guard active:** a banner saying live runs are paused today and samples still work.
- **Worker offline:** a banner saying live agent runs are temporarily unavailable and saved experiments remain viewable.

### 4.2 Creative Brief — `/projects/[id]/brief`

**Purpose.** Capture the challenge as structured data, then confirm the agent's interpretation (gate H1).

The layout is a two-column form (left) with a live "Brief card" preview (right).

| Field | Control | Validation |
|---|---|---|
| Title | Text | 1–120 |
| Creative challenge | Textarea with an example placeholder | 20–2000 characters |
| Cultural interests | 2–6 **interest chips**: text input + optional domain select (Book, Music artist, Film, TV, Podcast, Video game, Place, Brand, Destination, Person) | ≥ 2 required. Duplicates are blocked. |
| Venue | Type (select), locality (text, optional), capacity (number) | Capacity 1–5000 |
| Constraints | Budget band (segmented: low/medium/high), duration (minutes), notes (chips) | Optional |
| Goals | Up to 5 short text chips | ≤ 140 each |

- A privacy note sits under the form: *"Don't include personal information. Your brief is sent to an AI model and stored with this project. Only the cultural interests you confirm are sent to Qloo."*
- **Submit:** "Interpret brief". This creates a brief version and starts an EXPLORATION run.
- **Gate H1 (confirmation panel):** shows the `IntentFrame` as editable chips (interests with guessed domains, target domains, venue, constraints, goals), plus ambiguity callouts ("'Ghibli' could mean the studio's films or its music"). Buttons: **Confirm & discover** / **Edit brief**.
- **Version history:** a dropdown of brief versions; earlier versions are read-only.

### 4.3 Discovery Canvas — `/projects/[id]/discovery`

**Purpose.** Confirm entities (gate H2), then explore cross-domain threads and the collision pool.

**Entity confirmation panel (H2, shown when needed).** For each ambiguous interest there is a row with the user's text, candidate cards (name, Qloo type, details returned), and the actions **Use this**, **Refine** (inline text), and **Exclude**. Candidates are never auto-selected when ambiguous.

**Canvas (React Flow):**

- **Lane layout.** One vertical lane per domain (the warp). Seed entities sit at the top of their lane, with a thick border. Thread results flow down the target lanes, ordered by Qloo result position.
- **Edges:**
  - `THREAD`: solid, from a seed to its recommended entity in another lane.
  - `BRIDGE_SHARED_TAG`: a hatched curve labeled with the tag.
  - `BRIDGE_CO_OCCURRENCE`: dashed.
- **Collision Tension slider** (Harmonious ↔ Unexpected) at the top. Moving it re-selects the pool **client-side from stored scores** (instant), and highlights the selected candidate collisions as glowing weft lines across lanes. A "Generate hypotheses with this pool" button commits the selection and continues the run.
- **Inspector** (right side panel, which replaces the activity dock while open; the dock is still reachable): the selected node's facts with provenance chips, its tags, the threads it appears in, and a **Trace** button (request-to-result).
- **Filters:** domain, provenance, data origin; a "show only bridges" toggle.
- **Accessible alternative:** a **List view** toggle that shows threads as nested lists and bridges as a table.

### 4.4 Hypothesis Lab — `/projects/[id]/hypotheses`

**Purpose.** The heart of the product: inspect, compare, and select evidence-graded hypotheses.

**Layout:** a card board (default) or a graph tab.

**Hypothesis card:**

```
┌──────────────────────────────────────────────────────────┐
│ ● SUPPORTED                                Composite 78  │
│ Midnight Margins: City-Pop Reading Lounge   (Fraunces)   │
│ [Book] Novelist X  ×  [Music] Artist Y  ×  [TV] Show Z   │
│ Premise (AI interpretation) …                            │
│ Claims  ✔ 2 supports  ✖ 0 contradicts  ◌ 1 insufficient  │
│ Support ███████░ 82  Novelty █████░░ 64  Feasible ██████ │
│ [Inspect evidence] [What-if…] [Select for blueprint ☐]   │
└──────────────────────────────────────────────────────────┘
```

- **Columns or filters by status:** Supported · Partially supported · Under investigation · Inconclusive · Contradicted · Untestable. Contradicted and retired hypotheses stay visible in a collapsed "Retired" group, because honest negative results matter.
- **Evidence drawer** (opens from a card):
  - each claim, its test kind in plain language (for example "Do fans of X also favor Y-type films?"), and the stance badge;
  - evidence facts with Qloo data chips, the evaluator rule (*"SUPPORTS because Y appeared at position 4 of 20 recommendations"*), and the critic note labeled AI interpretation;
  - a **Trace** button.
- **Score breakdown popover:** the weights, the inputs, and an "adjust weights" control. Changing weights creates a rescore-only branch and is labeled as such.
- **Iteration timeline strip:** "Iteration 1 → 2 → 3" with what changed: refined, retired, spawned.
- **Gate H3 bar** (sticky footer): "Select 1–3 hypotheses to compose a blueprint", **Compose blueprint**, **Finish without selecting**.
- **Graph tab:** the evidence graph scoped to hypotheses (hypothesis → claims → evidence → entities), with the same provenance encoding.

### 4.5 What-if Lab — `/projects/[id]/what-if`

**Purpose.** Run counterfactual experiments and understand the differences.

**Left: the variable editor.** Shows the current experiment's variables as editable controls:

| Variable | Control |
|---|---|
| Seeds | Chips with **swap** (opens the resolve search), **remove**, **add** |
| Target domains | Toggle chips |
| Location | Locality search (🟡; disabled with an explanation if unsupported live) |
| Time window | Segmented 4/12/26/52 weeks (🟡) |
| Audience band (aggregate) | Segmented age bands 18–24 … 55+ or "Any" (🟡; disabled with an explanation if the harness does not expose demographic signals). The caption reads "Aggregate audience signal — not a prediction about individuals". |
| Collision tension | Slider |
| Scoring weights | Three linked sliders that sum to 100% |
| Constraints | Capacity, budget band, duration |
| Mode | Hold hypotheses (default, recommended) / Regenerate |

**Preview panel (before running):**

- "This change affects **7 Qloo queries**; **11 will be reused**. Estimated 7 live calls (daily allowance: 212 left)."
- If 0 dirty queries: "No new Qloo data needed — scores will be recomputed."
- Buttons: **Run branch** / **Cancel**.

**Right: the comparison view** (after the run, or when selecting any two experiments):

- **Header metrics:** dirty/reused/new results, drift index, the number of claims that changed stance, the number of hypotheses that changed status.
- **Hypothesis delta table:** each hypothesis with status (from → to), composite delta, and rank shift, sortable. Arrows plus text, never color alone.
- **Per-query diff:** for each dirty query, top-K lists side by side with entered (＋) and exited (−) entities, an overlap@K bar, and RBO.
- **Charts (Recharts):** a slope chart of composite scores parent → branch, and a stacked bar of stance distribution. Each chart has a "View as table" toggle.
- **Narrative card** (AI interpretation, with citations): "Swapping Nordic noir for the cozy-mystery tag moved *Midnight Margins* from Partially supported to Supported: 2 of 3 claims changed stance [E-14][E-15]…". All numbers are rendered from metrics.

**Branch tree** (top): a mini tree of root and branches. Clicking a node switches the comparison target.

### 4.6 Experience Blueprint — `/projects/[id]/blueprint`

**Purpose.** Turn selected hypotheses into an actionable, traceable plan.

- **Header:** title, format (event/series/installation), the source hypotheses (links), a revision selector, and status (Draft/Accepted).
- **Traceability meter:** a stacked bar of blocks by provenance (for example "62% Qloo-backed · 23% interpretation · 15% speculation"), with a link to "Show only speculative blocks".
- **Sections** (accordion or long-form): Concept · Audience · Programming · Atmosphere · Partners · Promotion · Logistics · Constraints & risks · Measurement.
  - Each **block** shows its text, a provenance chip, and evidence citation pills `[E-12]` that open the evidence drawer.
  - Edit-in-place uses a rich-text-lite editor (no HTML; Markdown subset). Saving creates a new revision. A user-edited block becomes `USER_PROVIDED` unless the user keeps its citations, in which case it is marked "edited by you".
- **Constraints panel:** constraints identified, with severity (info/caution/blocking), evidence, and suggested mitigation (interpretation).
- **Actions:** Export Markdown · Export JSON · Print/PDF (print stylesheet with the evidence appendix and provenance legend) · Share read-only · Recompose section (S).
- **Revision history:** a list with author (Agent/You), time, and change summary; selecting one shows a read-only view and a "Restore as new revision" action.

### 4.7 Project History — `/projects/[id]/history`

**Purpose.** Revisit, compare, and audit.

- **Timeline:** brief versions, experiments (with mode badge), branches (indented tree), runs (kind, state, duration, Qloo calls, LLM cost), and blueprints/revisions.
- **Experiment tree view:** an interactive tree. Select two nodes → **Compare**.
- **Run replay:** open any past run's activity timeline (read-only Activity Monitor).
- **Exports:** the project bundle as JSON.
- **Share links management:** list, copy (the token is shown only at creation), revoke, and expiry.

### 4.8 Read-only Share View — `/share/[token]`

**Purpose.** Let collaborators and judges view a project, experiment, or blueprint without workspace access.

- A minimal top bar: Tessaloom logo, a "Read-only shared view" badge, the expiry date, and a "Create your own experiment" CTA linking to `/`.
- Content depends on scope: a blueprint (with the evidence appendix), an experiment (the Hypothesis Lab and graph in read-only mode), or a project (an overview with links to its experiments).
- No run controls, no editing, no workspace data, and no raw request arguments beyond the redacted trace.
- Expired or revoked links show a friendly message: "This link is no longer active." The page does not reveal whether the project exists.
- `noindex` meta tag and `X-Robots-Tag: noindex`.

---

## 5. Agent Activity Monitor (dock and full view)

**Dock contents (top to bottom):**

1. **Run header:** run kind, a state pill (for example `COLLECTING EVIDENCE · iteration 2/3`), elapsed time, and **Cancel**.
2. **Needs-your-input card** (when paused): the gate question and action buttons, mirrored from the page gate.
3. **Budget meters:** Qloo calls `14 / 40`, LLM calls `6 / 14`, est. cost `$0.42 / $2.00`, time `2:31 / 7:00`. These are horizontal bars with a text value and turn saffron at 80%.
4. **Timeline:** a virtualized list of events, grouped by state. Each event shows an icon and its summary (≤ 280 characters). A tool event expands to show workflow, redacted arguments, envelope status, result count, latency, and data origin. A validation event shows the validator name and pass/fail with rule IDs.

**Full view** (`?activity=full`): a timeline plus a Gantt-style state duration chart (Recharts) and tool call statistics.

**Copy rules:**

- Decision summaries are written for creators, for example: "Kept 4 hypotheses, retired 1 after 2 contradicting checks."
- The monitor never shows "thoughts", "reasoning", or a chain-of-thought panel. The label is **"Decisions & actions"**.

**Live updates:** SSE, with automatic reconnect from `Last-Event-ID`. A "Live" indicator appears with a reduced-motion-friendly pulse.

---

## 6. Empty, loading, error, and recovery states

| Situation | Where | Treatment | Recovery action |
|---|---|---|---|
| No projects | Dashboard | Sample cards + illustration of an empty loom + "Start a new project" | — |
| Brief has fewer than 2 interests | Brief | Inline validation: "Add at least two interests from different worlds" | — |
| Run queued, worker busy | Dock | "Queued — your experiment will start shortly" + position if known | Cancel |
| Agent working | Any page | Shuttle-across-threads animation (reduced motion: a static progress bar) + current state label | Cancel |
| Skeleton loading | Cards, graph, tables | Content-shaped skeletons. Never spinners alone for more than 300 ms. | — |
| Gate waiting (H1–H4) | Page + dock | A highlighted "Needs your input" card; the browser tab title gets a "•" prefix | Answer / Cancel |
| Entity unresolved | Discovery | "Qloo found no match for 'XYZ'." | Refine · Exclude |
| Qloo `needs_input` | Discovery | Candidate cards from the response | Pick |
| Qloo partial/degraded | Evidence | A "Partial data" chip on the evidence + explanation | — |
| Claim inconclusive due to an error | Hypothesis Lab | Claim row: "Not tested — Qloo request failed (timeout)" | Retry evidence (starts a REVALIDATION scoped to failed claims) |
| Budget exhausted | Dock + Lab | "Stopped at the Qloo call limit (40). Results so far are shown; untested claims are marked." | Branch with a narrower scope |
| Quota guard active | Global banner | "Live experiments are paused for today to protect the shared Qloo quota." | Open samples |
| Qloo auth failure | Global banner (admin wording hidden) | "Live Qloo access is unavailable right now. Saved and sample experiments still work." | — |
| LLM unavailable or refused | Dock | "The AI step could not complete. Your data so far is saved." (Refusal: "Try rephrasing the brief.") | Retry step · Edit brief |
| Worker offline | Global banner | "Live agent runs are temporarily unavailable." | — |
| Run cancelled | Dock + page | "Run cancelled — evidence incomplete" ribbon on partial results | Start again |
| Network lost (SSE) | Dock | "Reconnecting…" with auto-retry; static data stays visible | — |
| Fixture mode (dev) | Global | A non-dismissible rust banner: "Development fixtures — not real Qloo data" | — |
| Share link expired | Share | "This link is no longer active." | Go to Tessaloom |
| 404 / unknown project | Any | "We couldn't find that project in this workspace." | Back to dashboard |

---

## 7. Onboarding (first three minutes)

1. **0:00** Landing hero: a value statement and **Explore a sample experiment**.
2. **0:10** The Hypothesis Lab opens on a forked sample, with a 4-step coach-mark tour (skippable, keyboard accessible):
   - ① a hypothesis card and its status;
   - ② the evidence drawer and Trace;
   - ③ provenance chips;
   - ④ the "What-if…" button.
3. **1:00** The user clicks **What-if…** on a card. The preset suggestion chip "Swap seed: Nordic noir → cozy mystery" is pre-filled. The preview shows the dirty query count.
4. **1:30** The branch runs in replay mode (pre-recorded for samples, labeled) or live (if the allowance remains, user's choice). The comparison view appears.
5. **2:30** The user opens the Blueprint tab of the sample, which shows the traceability meter.
6. **3:00** CTA: "Now try your own brief".

---

## 8. Accessibility (WCAG 2.2 AA)

- **Keyboard.** All controls are reachable by keyboard. Skip links are provided. Focus is visible (2 px warp outline, 3:1 contrast).
- **React Flow graph.** Nodes are focusable (`tabIndex`). Arrow-key navigation moves between connected nodes, Enter opens the inspector, and an `aria-live` region announces the selection. The **List view** offers equivalent information in semantic lists and tables.
- **Charts.** Each Recharts chart has a "View as table" toggle and an `aria-describedby` text summary.
- **Live regions.** The activity dock uses `aria-live="polite"` for state changes only (not every tool event), so screen readers are not flooded.
- **Motion.** `prefers-reduced-motion` disables the shuttle animation, edge animations, and pulses.
- **Targets.** Touch targets are ≥ 24×24 CSS px (2.5.8); primary actions are 44×44.
- **Forms.** Labels are always visible. Errors are linked via `aria-describedby`. Error and status messages are not conveyed by color alone.
- **Language.** `lang="en"`. Plain-language copy targets around grade 8 readability for UI text.
- **Testing.** axe-core in Playwright on every page (TEST_PLAN §10). There are also manual keyboard and screen-reader smoke checks (VoiceOver).

---

## 9. Responsive behavior

| Page | ≥ 1280 px | 768–1279 px | < 768 px |
|---|---|---|---|
| Dashboard | 3-column cards | 2-column | 1-column |
| Brief | Form + preview side by side | Stacked | Stacked; preview collapsible |
| Discovery | Lanes canvas + inspector | Canvas + sheet inspector | **List view default**; canvas optional |
| Hypothesis Lab | Board with status columns | 2-column grid | 1-column cards; drawer full-screen |
| What-if | Editor + comparison side by side | Tabs: Edit / Compare | Tabs; diff tables scroll horizontally inside their container |
| Blueprint | Sections + citations rail | Sections; citations inline | Sections; citations inline |
| Activity | Dock | Bottom sheet | Floating button → sheet |

---

## 10. Component inventory (shadcn/ui-based)

`ProvenanceChip`, `DataOriginBadge`, `StatusPill` (hypothesis/claim/run), `ScoreBar`, `ScoreBreakdownPopover`, `InterestChipInput`, `EntityCandidateCard`, `HypothesisCard`, `ClaimRow`, `EvidenceDrawer`, `TraceDialog`, `TensionSlider`, `WeightSliders` (linked), `VariableEditor`, `DeltaPreview`, `ComparisonHeader`, `RankDiffList`, `SlopeChart`, `StanceStackedBar`, `BranchTree`, `BlueprintSection`, `BlueprintBlock`, `TraceabilityMeter`, `RevisionList`, `ActivityDock`, `RunTimeline`, `BudgetMeter`, `GateCard`, `ModeBanner`, `EmptyState`, `ErrorState`, `CoachMarkTour`.

**React Flow node types:** `EntityNode`, `TagNode`, `HypothesisNode`, `ClaimNode`, `EvidenceNode`, `ExperimentNode`. **Edge types:** `ThreadEdge`, `BridgeEdge`, `StanceEdge`, `LineageEdge`.

---

## 11. Copy guidelines

- Say "**affinity**", never "people who like X will like Y". Qloo results are aggregate affinities, not predictions about individuals.
- Say "**evidence suggests**" or "**supported by Qloo data**", not "proves".
- Label speculation honestly: "Creative idea — not tested".
- Error messages say what happened, what is preserved, and what the user can do next.
- Avoid AI hype words such as "magic" or "genius". Use craft words: weave, thread, pattern, experiment, test.
