# Gemini 4 Argon synthetic workflow attempt (2026-10-27): stopped

This was the single owner-approved run: one exploration plus a blueprint, on a local release
stack with a fresh database. It used the synthetic Qloo transport, ran `gemini-4-argon` with
default thinking, and had $1.00 ledger caps, at most 17 Gemini requests and no retries.

| Time (UTC) | Step | Result |
| --- | --- | --- |
| 07:04:15 | R1 intent | `VALID`; `modelVersion` = `gemini-4-argon`; 1,737 in / 252 out / 0 thinking tokens; **8.3 s**; $0.0060 |
| 07:04:26 | Discovery (synthetic Qloo, no LLM) | about 3 s |
| 07:04:29 | **R3 hypothesis generation** | **Failed after 49.3 s.** `PROVIDER_UNAVAILABLE` with `USAGE_UNKNOWN`, classified non-retryable, so this was not an HTTP 429/5xx. The run became `FAILED` / `LLM_UNAVAILABLE` and **was not retried**. |
| 07:09:32 | Stop condition | The driver stopped; the server was stopped at once |

**Ledger:**

| Attempt | Status | Reserved | Settled |
| --- | --- | --- | --- |
| R1 | SETTLED | $0.0579 | $0.0060 |
| R3 | **UNKNOWN** (retained) | $0.1688 | — |

Total requests: **2 generations** (no metadata calls). The application's worst-case total is
$0.1748; actual billing is to be read in AI Studio.

**Cause.** The adapter recorded no detail for this class of failure: a failed connection, a
broken response body, a non-JSON body, or an HTTP 404. Commit `07b1546` (on
`claude/argon-probe`) now records which step failed, plus a system error code such as
`ECONNRESET`, never response content. The latency was within the 120 s request timeout.
