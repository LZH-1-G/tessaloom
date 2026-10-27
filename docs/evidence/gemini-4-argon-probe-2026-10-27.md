# Gemini 4 Argon contract probe (2026-10-27)

The single owner-approved paid probe. It used an invented brief ("Lantern Quay listening
night") with no Qloo data, the real R1 prompt and IntentFrame schema, default thinking, zero
retries, and a $0.06 reservation ceiling. Pricing was attested from Google's page at
2026-10-27 06:22 UTC ($2 input / $10 output per 1M tokens through 2026-11-30). The private
receipt (`~/.config/tessaloom/receipts/gemini-4-argon-r1.json`, mode 0600) refuses any repeat.

| Field | Result |
| --- | --- |
| Run | 06:37:15–06:37:25 UTC; 1 metadata GET + **1 generation** |
| Model metadata | `gemini-4-argon` supports `generateContent`; input limit 1,048,576; output limit **32,768** |
| Serving `modelVersion` | **`gemini-4-argon`**, exactly the configured ID (the adapter's strict check passes) |
| Schema | IntentFrame accepted after `$defs` inlining (no `400`). Zod and semantic validators passed on the first attempt (`VALID`, 0 repairs). |
| Stop | `end_turn` |
| Tokens | input 1,690; output 182; thinking 0 reported; cached 0 |
| Latency | **7.4 s** |
| Reservation (before sending) | $0.057438 |
| Estimated charge | **$0.0052** (1,690 × $2 + 182 × $10 per 1M), not yet reconciled with AI Studio |

The output interpreted both interests in order, kept the venue, budget and duration
constraints, and asked one clarifying question per invented title instead of guessing.

## Limits of this evidence

This proves the contract (model ID, request shape, one schema, usage accounting) on one short
role. R3/R4/R6 prompts are larger and may think longer. Their latency, truncation and schema
acceptance are measured only by a full synthetic workflow.
