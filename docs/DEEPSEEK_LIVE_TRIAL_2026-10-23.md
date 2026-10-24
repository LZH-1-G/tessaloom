# DeepSeek first authorized live trial — 2026-10-23

**Completed exactly two sequential `deepseek-v4-pro` requests using locally invented cultural inputs. Both returned HTTP 200 and passed JSON parsing, strict application schema/unknown-field checks, and the frozen semantic validators. Zero retries, repairs, fallback calls, real Qloo inputs, or extra provider API requests.**

The existing local checkpoint `6e210c283e81d850c7dad6bc53139f86930c43b2` and branch `codex/live-provider-validation` remain unchanged. No push, merge, deployment, recharge or account creation occurred. The one-shot harness and this report are local additions.

## Measured results

| Case | Request time (Asia/Shanghai) | Serialized bytes | Input tokens | Cache hits | Output tokens, including reasoning | Reasoning tokens (subset) | Latency | Validation |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| R3: cultural hypothesis generation | 20:02:40 | 8,747 | 2,455 | 0 | 3,808 | 2,125 | 46.294 s | PASS |
| R4: unsupported causal-claim critique | 20:03:26 | 4,506 | 1,099 | 0 | 628 | 435 | 9.428 s | PASS |
| Total | | 13,253 | **3,554** | **0** | **4,436** | **2,560** | 55.722 s | **2/2** |

Total provider-reported tokens: **7,990**. Reasoning tokens are already included in output; they are not charged twice. Both actual response model fields were exactly `deepseek-v4-pro`. The documentation maps this alias to DeepSeek-V4-Pro-0813, but the responses did not independently attest that version. No Flash model or R6 blueprint-composition call was tested.

Limits were checked before dispatch: at most two calls, 16,384 serialized UTF-8 bytes per request, 8,192 output tokens per request including reasoning, low reasoning effort, a 60-second HTTP deadline, JSON Schema output, no tools/search, fixed official endpoint, and no redirects. Request fingerprints matched the frozen offline rehearsal. A first-call transport, usage, schema or semantic failure would have stopped the second call; neither case failed.

## Cost: measured usage versus account debit

Official [CNY pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) was rechecked before execution. Pro peak prices per million tokens were CNY 9 uncached input, 0.30 cached input, and 27 output. The documented off-peak prices were 4.5, 0.15 and 13.5 respectively. These requests occurred after 18:00 Beijing time, in the documented off-peak period.

| Case | Actual tokens × off-peak tariff (CNY) | Actual tokens × peak tariff (CNY) | Persistent conservative USD settlement |
| --- | ---: | ---: | ---: |
| R3 | 0.0624555 | 0.124911 | 0.024983 |
| R4 | 0.0134235 | 0.026847 | 0.005370 |
| Total | **0.075879** | **0.151758** | **0.030353** |

**CNY 0.075879 is the calculated cost from actual token usage and the published tariff, not a verified account debit. The responses supplied no monetary cost field. Provider-reported cost and actual balance deduction therefore remain unverified.** No balance endpoint or additional provider request was made. The user's reported CNY 16.06 starting balance was not independently checked; no ending balance is claimed.

M10-A used the conservative peak tariff and **USD 0.20/CNY**, rounding each settlement upward to micro-USD. The dated reference fixing was USD 1 = CNY 6.7180 ([SAFE table](https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do?COLLCC=546877760), [Xinhua report](https://www3.xinhuanet.com/20261023/b9e468eaceb349b2bc8a22587505c64c/c.html)); the chosen accounting factor is about 34.36% above its inverse. This is an internal accounting factor, not a bank exchange execution.

The planned total budget remained **CNY 2**, with a USD 0.40 ledger ceiling. Before each request the ledger reserved USD 0.081101; the two-call conservative planned reservation was CNY 0.811008 before USD rounding. Both reservations settled successfully. Token/byte estimates and application caps are not a guaranteed account-side billing ceiling.

## Quality and grounding assessment

R3 produced **Paper Static Coastline** and **Lanterns in Static**: a book/music-led reading, mapping and listening evening, and a film-led pass-the-lantern discussion with departure notes. Each had three structurally testable claims and known supplied entity IDs. Decorative additions in `creativeElements` were marked `CREATIVE_SPECULATION`; no attendance or revenue guarantee was offered.

The output is substantially more concrete than the scripted baseline's generic title pairings and listening/browsing corners. However:

- Both hypotheses use the same three entities and closely related mapping/ferry/lantern motifs, so their distinctness is moderate.
- The premise assumes a “cartographic mood” and “low-lit texture” from invented names although no content metadata was supplied. Those descriptions should be explicitly framed as creative assumptions. Passing identifier/schema validation did not establish these descriptions as facts.
- Projection, clips, excerpts, soundbeds and printed decorations need availability, rights and budget checks. The model preserved the supplied 90-minute/24-person constraints, but low-budget feasibility was not fully demonstrated.
- Affinity and bridge claims remain hypotheses. No Qloo validation or actual demand evidence was obtained.

Human rubric (subjective, not a statistical benchmark): originality/distinctness **1/2**; meaningful cross-domain connection **2/2**; small-venue feasibility **1/2**; testability **2/2** — **6/8**. The limited three-entity fixture constrains diversity.

R4 performed strongly on the designed evidence challenge. It cited exactly the supplied synthetic evidence, identified the lack of causal/attendance/revenue observations, rejected the guarantee, recommended **retire**, and suggested an exploratory affinity test instead. It did not upgrade the supplied INCONCLUSIVE stance. The scripted critic only advised generic refinement and described the evidence as directional; DeepSeek's visible explanation was more precise and relevant.

Reasoning quality was assessed from the visible structured decisions and explanations, not by retaining or presenting private reasoning traces. Raw reasoning text was not persisted. R6 blueprint composition, production latency/reliability, broader cultures/languages and Flash cost-quality tradeoffs remain untested.

## Security, ledger and regression evidence

- Revalidated **42** provider/contract/frozen-plan unit tests and **20** PostgreSQL spending/access tests. Type checking, ESLint and formatting passed for the added harness. A complete offline rehearsal exercised the same bundle, actual database guard, schemas, exact bodies and isolated OS identities with a sentinel and injected synthetic transport.
- The real credential was loaded only into worker UID/GID **10002** from a private tmpfs file. Host directory/file modes were checked as 0700/0600. Web UID/GID **10001** had no key in its environment and was denied both the secret-file read and the worker `/proc` environment read. This check happened in the live container before dispatch authorization was released.
- The immutable local image was `sha256:27e84debd59a68d27b9cb284611595c0b325b842f453d4ec20ce6829d6901d8b`. The disposable worker had no web server, published ports, host binds, Docker socket or restart policy; its root filesystem was read-only. The key was absent from Docker environment metadata and logs. The trusted bootstrap used stdin rather than command-line credential arguments.
- The test used a **separate, preserved local trial database** with the actual M10-A repositories and worker gateway; it did not alter production/public access. Global, workspace, experiment, run and invite-grant scopes were all capped at USD 0.40 in that database. No public visitor was granted paid access.
- Before paid dispatch, invalid/nonfinite/expired accounting was rejected, `RUN_ACCESS=off` denied reservation, and the authorized run's durable ceilings were verified. After execution, persistent counters showed **2 attempts**, **16,384 reserved output tokens**, and **30,353 micro-USD** settled usage. Both reservations were `SETTLED`.
- The single-use grant was revoked and the trial run closed (`CANCELLED` as an administrative stop, not a failed quality result). The container/tmpfs was removed. Receipts and ledger remain for reconciliation; no automatic rerun is enabled.
- Final artifact checks: the exact private key was absent from all new source/report/evidence files, the bundled runner and execution logs; a network-disabled Gitleaks scan of the copied artifacts passed.
- Live errors/retries were not induced. Both live calls succeeded; zero retries/fallbacks were observed. Timeout, malformed usage, uncertain billing, cap exhaustion, invalid pricing and failure latching were exercised offline.

[Structured evidence, validated outputs and scripted comparison](evidence/deepseek-quality-2026-10-23.json) contain synthetic inputs/results and safe metadata only. The private host receipt also retains an exclusive authorization claim. Secrets and raw reasoning are absent from the report and evidence.

## Decision

**DeepSeek is a promising, provisionally suitable live provider for guarded Tessaloom hypothesis generation and evidence critique.** This two-call sample supports further controlled evaluation, not public paid generation or production readiness. Creative output needs clearer separation of invented aesthetic assumptions from known entity metadata.

Remaining blockers for real Qloo + DeepSeek: Qloo event quota/permitted usage, explicit permission to share Qloo-derived material with DeepSeek, and any raw-evidence retention permission. Actual account debit reconciliation, blueprint-composition evaluation, and broader reliability/quality checks also remain. Any further paid call requires separate authorization; none is implied by unused budget.
