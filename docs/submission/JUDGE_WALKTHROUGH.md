# Judge walkthrough — Harbor Lights

This is a reproducible demonstration of working software. **FIXTURE — not real Qloo data.** Cultural titles, entities and affinity values are invented; generation uses scripted AI. The separately recorded DeepSeek trial is not part of this walkthrough. Nothing here makes provider API calls.

## Interactive path (local, approximately 5 minutes)

Start the complete web + worker stack using the README. Create a café project named **Harbor Lights**. Keep the same browser profile: its anonymous workspace cookie is the key to project history. Private browsing or deleting cookies creates a different workspace, not a recovery of the old one.

| Stage                 | Action                                                                                                                                                              | What to inspect                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creative Brief        | Choose **Use the fixture example** in an empty brief; review the three invented interests, capacity 40, low budget, duration 120 minutes; click **Interpret brief** | A brief version is persisted. The example only fills fields; it does not start a run or overwrite an existing brief.                                                 |
| Intent confirmation   | Review the interpreted domains; click **Confirm & discover**                                                                                                        | This is the first human confirmation gate. Ambiguous interests in other briefs require an explicit selection; they are not silently guessed.                         |
| Cultural Discovery    | Follow **Open the Discovery canvas**; inspect threads and the list alternative                                                                                      | Fixture labels accompany cultural evidence. This is an actual worker/queue run.                                                                                      |
| Cultural Collision    | Review the collision pool; adjust tension if desired; choose **Generate hypotheses with this pool**                                                                 | The pool is committed before generation. The original brief and choices remain recorded.                                                                             |
| Hypothesis Lab        | Use the **Hypotheses** step; compare cards, claims, scores and evidence                                                                                             | Support is separate from novelty/feasibility. Insufficient and untestable claims remain visible.                                                                     |
| Evidence Graph        | Open **Evidence graph**; inspect entities, hypotheses, claims and evidence; use the List alternative or keyboard navigation                                         | Labels distinguish fixtures, calculations, interpretation and speculation. Trace a claim to its request and fact pointer; original retrieval is separate from reuse. |
| What-if               | Return to **Board**, open **Score breakdown**, then **Adjust weights**; change support weight and create a rescore-only branch                                      | The comparison explains that no new cultural data was queried. A seed swap in the separate regression journey recomputes only dependent queries.                     |
| Experience Blueprint  | Choose **Compose a blueprint from this branch**, review selected hypotheses and format, then compose                                                                | Constraints, evidence-backed blocks, interpretation and creative speculation are separate. Reused fixtures retain their label.                                       |
| Edit / Export / Share | Edit a programming block and save a revision; export Markdown; create a read-only link                                                                              | User edits are labelled and revisions retained. Export carries citations, provenance and uncertainty.                                                                |
| Independent reader    | Open the share in a private window; then revoke it from the owner window                                                                                            | No editing or paid-generation controls appear in the shared document. Revocation makes it inactive immediately.                                                      |
| Persistence           | Reload or return to the studio in the original browser                                                                                                              | The project, brief versions, experiment results and blueprint revisions persist.                                                                                     |

Cancellation and recovery are not theatrical demo steps: the browser activity-monitor regression checks cancellation, and container/integration suites exercise restart/recovery. Show partial results as partial; do not relabel a cancelled or insufficient run as successful.

## Prepared read-only sample path (local; public mode unresolved)

The existing production restrictions remain intact: production refuses synthetic/scripted generation **and fixture-derived reads**. `RUN_ACCESS=off` and zero budgets prevent new work. Prepared synthetic samples work in the local test/development environment, but the same sample payload returns 403 in production. No firewall exemption is introduced. Keep this guard unchanged. The recommended judge presentation is a local interactive walkthrough or clearly labelled screen recording of this synthetic journey, alongside separately identified historical provider verification. A recording is supporting material, not evidence of a working public production demo. The public application must use only authorized nonfixture content under the existing guard, with generation disabled for anonymous visitors. Real Qloo functionality must remain separately identified and requires confirmed rights, quota and explicit validation approval before activation.

A local preparation helper runs the same verified worker pipeline and creates a parent experiment, a weights-only branch, a composed blueprint and two featured samples. It refuses nonlocal URLs, populated databases and environments containing API keys. It disables HTTP and uses fixed synthetic/scripted ports. It neither reads private provider files nor enables a public service.

```sh
# Create a NEW local database with your existing local PostgreSQL tooling:
# database name must be tessaloom_demo or tessaloom_demo_<lowercase suffix>.
APP_ENV=test DATABASE_URL_MIGRATOR=postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom_demo pnpm db:migrate
pnpm exec esbuild scripts/seed-judge-demo.ts --bundle --platform=node --target=node22 --format=esm --external:pg-native --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile=scripts/dist/seed-judge-demo.mjs
DATABASE_URL=postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom_demo node scripts/dist/seed-judge-demo.mjs
```

The database must already exist and be migrated. Do not point this helper at a work database, start a second worker against it during preparation, or rerun it over prepared data. It prints public sample paths, never bearer tokens. Samples expire after 60 days; record the actual date and renew or recreate through a reviewed operator action before it lapses. The local preparation uses regression-driver utilities intentionally and is not shipped as an automatic production startup job.

In the prepared local demo database, visitors can open the project overview and complete blueprint under **Demo samples**. They can read findings without a workspace, access code or provider call. These sample pages do not offer editable graph/What-if controls; the complete interactive path above is independently tested. Do not promise an anonymous full interactive public demo when only samples are exposed.

## Gallery and narration

The existing gallery under `docs/evidence/m5`–`m9` is historical synthetic evidence. Current read-only sample screenshots, including desktop and 390px mobile layouts, are selected in `docs/submission/gallery/`. The full interactive browser run also passed graph, branch, share and mobile checks; its transient screenshots were superseded by later runs and are not represented as archived gallery evidence. Keep visible fixture labels in all crops and captions.

Suggested 90-second narration: “A venue has three cultural interests, but no proof they share an audience. We turn connections into claims, inspect their sources, and change one assumption. This branch reuses the original evidence rather than making it look freshly retrieved. Finally, the blueprint keeps practical ideas separate from evidence. This demonstration is synthetic; the repository separately records real provider checks and their limits.”

To verify prepared local sample pages in both browsers without resetting their database:

```sh
E2E_SAMPLE_DATABASE_URL=postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom_demo pnpm exec playwright test --config playwright.samples.config.ts
```
