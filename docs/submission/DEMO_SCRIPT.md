# Demo outline, video and gallery

**Source of footage.** Record the real Spirited Away + Joe Hisaishi project: the local
acceptance database now, or production after the final acceptance run. Real Qloo results may
appear in the video and in Devpost screenshots ([rights review](DATA_RIGHTS_REVIEW.md)). Never
commit them to the repository. Show no access codes, share tokens, keys, terminal windows or
browser profiles. If you show the local fixture demo, keep its **FIXTURE** banner in frame and
say it is synthetic. The narration quotes the local run (93 bridges; *Kiki's Delivery Service*
first of six). Use the numbers from whichever run you record.

| Time | Screen | Narration |
| --- | --- | --- |
| 0:00 | Home page | "A 40-seat café wants a quiet weeknight to become a regular event. Its audience loves *Spirited Away* and Joe Hisaishi's music. What could connect them, and how would we know it isn't just a hunch?" |
| 0:15 | Brief, then the interpretation | "Tessaloom starts with a brief. A Claude agent reads it into an intent: interests, worlds to explore, constraints. It asks when something is ambiguous instead of guessing." |
| 0:35 | Entity selection | "Qloo resolves each interest. The user picks the exact entity; nothing ambiguous is chosen for them." |
| 0:50 | Discovery canvas, then the collision pool | "Qloo recommendations thread each interest into books, music, film and places. Items that show up from both interests become bridges between worlds: 93 here. The tension slider trades familiar for surprising." |
| 1:15 | Hypothesis lab, then an evidence drawer | "Claude writes hypotheses, each with testable claims. Tessaloom plans a Qloo query per claim, and fixed rules grade the result: supports, contradicts, neutral or insufficient. Here, *Kiki's Delivery Service* ranked first of six Ghibli options for this audience." |
| 1:45 | Evidence graph, then the trace | "Every claim traces back to the request, the fact and the rule. A critic agent challenges weak ideas, so a hypothesis with contradicting evidence is marked, not hidden." |
| 2:05 | Blueprint, then the traceability meter | "The composer turns the chosen idea into a plan. The meter shows which blocks are evidence, which are interpretation and which are speculation, and every citation opens the stored evidence." |
| 2:25 | Share → The whole story; the read-only page on a phone | "Share the whole story read-only: brief, discovery, tested hypotheses and blueprint, with the limits stated." |
| 2:40 | Closing frame | "Qloo supplies the taste signals; Claude agents reason over them; Tessaloom keeps the evidence and the imagination apart." |

## Devpost gallery (captured 2026-10-26, kept outside the repository)

Five screenshots of the real local run (live Qloo data, Claude Sonnet 5.5 via the owner's
subscription), taken from the stored results with **no worker, no Qloo call and no model call**:
the web process alone served the local acceptance database. Desktop at 1440 × 900 with the
status header cropped off (it shows "Qloo unavailable" when no worker runs), phone at 390 × 844.
The files were handed to the owner, not committed.

| File | Caption |
| --- | --- |
| `1-discovery-canvas.png` | Qloo threads *Spirited Away* and Joe Hisaishi into film, music, books and places; items reached from both interests become bridges. |
| `2-hypothesis-evidence.png` | Each claim becomes a Qloo query graded by a fixed rule: "ranked 1 of 6 (top third)". A critic agent adds interpretation but cannot change a stance. |
| `3-evidence-graph.png` | Cultural entities, hypotheses, claims and evidence in one graph, each labelled Qloo data, AI interpretation or creative speculation. |
| `4-blueprint.png` | The composed plan with its traceability meter: 13% evidence-backed, 53% interpretation, 33% speculation; 7 citations, all resolving to stored evidence. |
| `5-story-phone.png` | The read-only story on a phone: 93 candidate bridges, 3 taken forward, hypotheses tested against Qloo evidence. |

**Redaction:** the evidence drawer and trace show the Qloo entity ID behind each grading
(`/results/0/entity_id = "…"`). In `2-hypothesis-evidence.png` those pointer values are hidden;
the rest of the page is unchanged. Do the same in any new capture until Qloo answers the
[request](QLOO_PERMISSION_REQUEST.md). Never show access codes, share tokens, keys, terminals or
browser profiles.

## Produced videos (2026-10-27, kept outside the repository)

| File | What it is |
| --- | --- |
| `tessaloom-demo.mp4` | 1:43, 1440 × 900, H.264 + AAC. Eight narrated segments (macOS voice) with on-screen subtitles: brief → entities → discovery (bridges only) → hypothesis lab and evidence drawer → evidence graph → blueprint and traceability meter → read-only story → closing |
| `tessaloom-mobile-story.mp4` | 0:27, phone format (390 pt wide), the read-only story scrolled with short captions; no audio |

**How they were made (no new calls).** The web process alone served the saved local run
(`APP_ENV=development`, no worker, no model key), so no Qloo or model call was possible.
Chromium's screencast captured timestamped frames while a script followed the storyboard; macOS
`say` produced the narration; a small AVFoundation program wrote H.264 and placed each narration
segment at its scene's start. A chip on every frame reads *"Saved local run · live Qloo data
(retrieved 2026-10-26) · Claude Sonnet 5.5 · no new calls while recording"*.

**Checked before delivery:** Qloo pointer IDs are hidden in the evidence drawer and **Trace** is
never opened; no access code, share-link field, token or terminal appears; the "worker offline"
banner and status dot of the offline recording setup are hidden, and the chip says so. The
narration distinguishes Qloo data ("That ranking is Qloo data") from AI interpretation and
creative speculation.

**Publishing:** both files show Qloo-derived names. Upload them (unlisted) only once Qloo's reply
allows it, or with that risk accepted knowingly; a video is optional under the rules.

## Live demo order for judges

Public URL → **Demo samples** → *Spirited sound evenings* (read-only story, no code needed). If
judges have an access code: Home → enter code → create a café project → two interests →
Interpret → Confirm → Discovery → Generate hypotheses → Compose blueprint. A run takes a few
minutes; the activity panel shows progress, and a stop explains what to do next.
