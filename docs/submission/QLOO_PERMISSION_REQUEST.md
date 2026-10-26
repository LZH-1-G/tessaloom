# Qloo data-display permission request (ready to send)

**Send to:** the Qloo Hackathon Discord `#api-help` channel (named in the
[developer guide](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide)), or the
contact address on the [official rules](https://qloo.devpost.com/rules) page, section 14.
**Status:** prepared 2026-10-26, **not sent**: sending needs the owner's account. Until a
reply arrives, fields marked "until confirmed" stay out of every public page and export.

---

**Subject:** Tessaloom (Qloo Agentic Hackathon): confirming what our public demo may display

Hi Qloo team,

I'm building **Tessaloom** for the Qloo Agentic Hackathon. Venue owners give it two or three
cultural interests; Claude agents use the Qloo Insights API (through the official Qloo Harness
0.1.26) to find cross-domain connections, test each idea's claims against Qloo results, and
produce an event plan that labels what is Qloo evidence and what is AI interpretation.

Following the developer guide, Qloo responses are kept only in our private server-side database,
raw responses are not retained, and no Qloo response data is stored in our public repository.

Could you confirm whether the following is fine on our **public demo site** (judges and visitors,
during and after judging) and in **Devpost screenshots/video**?

1. **Entity names and types returned by Qloo** (e.g. "Spirited Away", Film), labelled
   "Cultural data: Qloo".
2. **Our own rule-based gradings of Qloo results**, e.g. "ranked 1 of 6 for this audience" or
   "carries the theme tag 'Animation'", with the retrieval date. We don't show the underlying
   scores.
3. **Read-only share links and Markdown/JSON exports** of a finished plan, containing items 1–2
   plus our generated text, with no IDs, scores or descriptions.

Until we hear back, we are **not** showing publicly: popularity or affinity values, Qloo entity
descriptions/disambiguation text, Qloo IDs, or any raw response. Inside the app, a signed-in
visitor choosing between ambiguous entities does see Qloo's short description, as part of the
API's normal use. Please tell us if that needs to change too.

Also: judges will be able to run the agent with their own inputs during Nov 2–5 using capped
access codes, which makes Qloo calls with our event key. Is that within the key's intended use
and quota?

Thank you!
— LZH-1-G (Tessaloom)
Demo: https://p01--tessaloom--mpfcqkyl42yb.code.run
Code: https://github.com/LZH-1-G/tessaloom

---

## What changes with each answer

| Answer | Action |
| --- | --- |
| Items 1–3 confirmed | No change; keep the current public story and exports |
| Names fine, gradings not | Remove rationales from public payloads (`projectStory`, appendix) and keep stances only |
| Display not permitted | Unfeature samples (`admin.mjs sample unfeature`); keep the interactive demo only |
| Judge runs not OK on our key | Keep `RUN_ACCESS=off`; offer the read-only story plus the local fixture demo |
