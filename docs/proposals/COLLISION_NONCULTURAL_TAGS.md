# Proposal (not implemented): ignore non-cultural Qloo tags when forming bridges

**Status: awaiting owner approval.** This changes the collision algorithm, so it was measured
offline and left unimplemented. It makes no Qloo calls and does not change quota use.

## Evidence (offline replays of stored data, 2026-10-26)

| Run | Candidates today | Basis | With the filter |
| --- | ---: | --- | --- |
| *Norwegian Wood* + Nujabes (`POOL_TOO_SMALL`) | 1 | One pair: an artist and a place sharing the tag **"Identifies as women-owned"** (`urn:tag:inclusivity:place:…`) | 0 (same failed outcome, without a meaningless bridge) |
| *Spirited Away* + Joe Hisaishi (completed) | 93 | **All 93** via co-occurrence (the same item in both interests' threads); none rely only on a tag | 93, identical 3 selected |

Run 2's tags included the classes `credit_card`, `cost_description`, `hotel_rating`,
`inclusivity`, **`ethnicity`**, `good_for`, `host`, `endorsement`, `specialty_dish`,
`category` and `book_format`. A bridge resting only on a payment method, a price description,
a hotel rating or an ethnicity tag is not a cultural connection. The `ethnicity` and
`inclusivity` classes also touch the kit's sensitive-trait guidance.

## Change

In `apps/worker/src/orchestrator/context.ts`, when building `ctx.tags`, skip tags whose class
(the third URN segment, `urn:tag:<class>:…`) is in a reviewed deny-list. Unknown classes stay
allowed. The tags themselves stay stored and visible in the studio. Add a unit test for the
filter and a replay test with the two cases above.

## What it does not fix

`POOL_TOO_SMALL` itself. Live bridges come almost entirely from co-occurrence, so the
effective remedies are more or broader interests. The new Discovery guidance already says
so. More tag enrichment (`MAX_TAG_ENRICHMENT = 8`) would spend more shared Qloo quota for a
benefit the data above does not show, so it is **not** recommended.
