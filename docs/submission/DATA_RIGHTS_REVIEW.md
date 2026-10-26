# Public display and data-rights review — 2026-10-26

Scope: what the public demo sample, project shares, the repository and the Devpost page may show.
This is an engineering reading of the published terms, not legal advice.

## Sources read on 2026-10-26

| Source | What it says that matters here |
| --- | --- |
| [Official rules](https://qloo.devpost.com/rules) | A working app integrating the Qloo API; a **link to a functional demo**; a **public** repo with an open-source license; access for judges free of charge until judging ends (Nov 2–5, 2026), with login credentials in the testing instructions if the site is private. Third-party SDKs/APIs/data must be used within their terms. Submission deadline **Oct 30, 2026, 11:45 PM ET**. |
| [Qloo hackathon developer guide](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide) | *"Private server-side caching is fine and there is no time limit."* *"Do not store Qloo response data in a public repository."* Keys work until judging ends, then are deactivated. Display rules, attribution and score display are **not addressed**. |
| [Kit SUBMISSION.md](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/SUBMISSION.md) | Expects a redacted request-to-result explanation, screenshots without credentials or personal data, and Qloo results used as evidence in a product flow. |
| [Kit SAFE_USE.md](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/SAFE_USE.md) | Present results with source and limits; separate Qloo results from product interpretation; no causal claims or claims about individuals; no personal data. |

## Field classification (public sample / project share)

| Field | Class | Treatment |
| --- | --- | --- |
| Brief: title, challenge, interests, venue type, capacity, budget band, duration, goals | **Clearly permitted** (user's own text, no personal data by UI instruction) | Shown |
| Brief locality and free-text notes | **Unclear** (could identify a small venue or person) | Excluded |
| Resolved entity names and types (seeds, thread items, bridges) | **Permitted with attribution** (displaying results in the app is the product use the kit describes) | Shown, labelled "Qloo data", with "Cultural data: Qloo" |
| Discovery counts per world, bridge counts, which items appear in several threads | **Permitted with attribution** (Tessaloom's counts over Qloo results) | Shown |
| Evidence stance and rule rationale (e.g. "ranked 1 of 6 (top third)", "carries the theme tag 'Animation'") | **Permitted with attribution** (Tessaloom's deterministic grading of a Qloo result, with origin and retrieval date) | Shown with provenance chip |
| Hypotheses, premises, blueprint text, composite scores | **Clearly permitted** (Tessaloom/LLM output; Qloo-backed blocks cite evidence) | Shown, labelled interpretation/speculation |
| Qloo popularity and affinity values, raw tag weights | **Unclear** (proprietary signals; display not addressed) | Excluded |
| Qloo entity descriptions, images, external IDs, ISBNs, `akas`, snapshots | **Unclear**, likely Qloo or third-party content | Excluded |
| Qloo entity and tag IDs | **Unclear**; not needed for display | Excluded |
| Raw API responses | **Prohibited in a public repository**; not retained server-side either (`QLOO_RAW_RETENTION=off`) | Never stored or shown |
| Pool relevance/novelty numbers | **Clearly permitted** (computed), but noise for readers | Excluded from the public story; shown in the studio |
| Run IDs, workspace IDs, invocation IDs, tokens, costs, model traces | **Internal**, not Qloo data | Excluded (asserted by `tests/integration/m9-share-api.test.ts`) |

The rules for these fields live in `projectStory` in `packages/db/src/repositories/blueprint.ts`
and are enforced by the integration test above. The browser test checks the rendered story and
its limitations wording.

## By content type (updated 2026-10-26)

| Content | Where it appears | Public treatment |
| --- | --- | --- |
| App-generated original text (UI copy, rule rationales, limitations) | Everywhere | Ours; shown |
| Generated hypotheses and blueprints (Claude output, labelled interpretation/speculation) | Studio, story, exports | Ours; shown, labelled; Qloo-backed blocks cite evidence |
| Qloo-derived entity names and types | Studio, story, exports, blueprint text | Shown with "Qloo data" / "Cultural data: Qloo" attribution (permitted with attribution, pending organizer confirmation) |
| Qloo descriptions, disambiguation text, raw responses | Studio only: the entity-confirmation step shows Qloo's short description to the user choosing an entity | Never in the story, samples, share payloads or exports; raw responses never stored |
| Qloo rankings as gradings ("ranked 1 of 6", "top quartile") | Evidence rationales | Shown as Tessaloom's rule outcome, with origin and date |
| Qloo popularity and affinity values | Not displayed publicly | Excluded from every public payload and export (tests) |
| Internal identifiers (Qloo IDs, run/workspace/invocation IDs) | Owner's private views only | Excluded from public payloads and **shared exports** (fixed 2026-10-26, test) |
| Third-party copyrighted media (cover art, posters, photos) | None | Not fetched or displayed; CSP `img-src 'self' data:` blocks external images |
| Fonts | UI | Fraunces, Inter, IBM Plex Mono (SIL OFL), self-hosted at build |

Interactive use by a judge or visitor shows Qloo results to that person in the course of the
app's own function. That is the product use the kit describes, not redistribution. It still
follows the same rule: no raw responses are retained.

## Repository audit (going public)

- No real Qloo entity IDs are tracked. The search for Qloo-style uppercase UUIDs found none.
- Tag URNs in tests are format examples (`genre:media:mystery`, `genre:music:pop`), not response data.
- `docs/research/QLOO_V1_VALIDATION.md` records API behaviour: shapes, counts, one query input and
  qualitative outcomes. No payloads, IDs, scores or descriptions. **Low risk; keep.**
- Local acceptance docs name only user-entered interests, LLM hypothesis titles and counts.
- Screenshots in `docs/evidence/` and `docs/submission/gallery/` are synthetic fixtures.
- **Rule going forward:** screenshots or exports of real Qloo results never go into the
  repository. They may go in the Devpost gallery or video (see below), and real results are
  served only from the private server database.

## Devpost gallery and video

The kit asks for screenshots and a demo, so showing real results there is the expected use,
but the guide's "public repository" rule shows Qloo is sensitive to bulk redistribution. Use
screenshots of the in-app story, which already exclude every **Unclear** field. Do not add
data exports or raw JSON.

## Organizer clarification (send on Discord #api-help, or email via Devpost)

> Hi — Tessaloom (Qloo Agentic Hackathon). Our public demo shows a read-only example produced by
> the app: entity names and types returned by Qloo, our own rule-based gradings of Qloo results
> (e.g. "ranked 1 of 6 for this audience"), with the label "Cultural data: Qloo" and the
> retrieval date. We do **not** show popularity or affinity values, Qloo descriptions or raw
> responses, and we keep responses only in a private server-side database, per the developer
> guide. Could you confirm that (1) displaying those names and gradings on the public demo and
> in Devpost screenshots is fine, and (2) judges entering their own interests (which calls
> Qloo with our key, within quota) is fine during Nov 2–5? Thank you!

Until there's an answer, the excluded fields stay excluded. The answer doesn't block the
read-only sample, which already shows only fields classed as permitted.
