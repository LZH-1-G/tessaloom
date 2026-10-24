# PR #14 Docker smoke readiness fix

Scope: only `scripts/container-smoke.mjs`, its polling helper and focused regression tests. No application/provider policy, workflow assertions or readiness criteria changed. No live provider calls, push, merge or deployment.

## Failure evidence

- Head: `160ad0ed5e682a7600f2448b62677fb1e4662c88`.
- [PR Docker job 120788786395](https://github.com/LZH-1-G/tessaloom/actions/runs/40065836626/job/120788786395) failed; [push Docker job 120788679084](https://github.com/LZH-1-G/tessaloom/actions/runs/40065801139/job/120788679084) passed at the same head. CI used Node 22.23.3. Other core checks passed; CodeQL was skipped.
- The failed run recorded `image_migrations_applied` at 05:22:14.325 UTC and unsettled top-level await at 05:22:14.922 UTC, at the startup `until()` call (old line 162). It never reached `process_isolation_passed`.
- The awaited operation was a `fetch` of `GET /api/health/ready`, expecting HTTP 200. PostgreSQL TCP readiness and migration had already completed; the application container had started and its mapped port had been obtained. Neither the 3-second abort timeout nor the 60-second readiness deadline had elapsed.
- The old deadline was only checked between probes. Its referenced 200ms delay existed only after a probe resolved/rejected. During `await check()`, no timer owned by the poller kept Node alive. `AbortSignal.timeout()` uses an unreferenced timer, and a pending promise alone is not an event-loop handle. [Node documents exit 13](https://nodejs.org/api/process.html#exit-codes) for unsettled top-level await and [unreferenced timer behavior](https://nodejs.org/api/timers.html#timeoutunref).
- A standalone ESM child under both Node 26.11.1 and the exact CI runtime, Node 22.23.3, running the old `until()` with a probe awaiting only `AbortSignal.timeout()` reproduced exit 13. This isolates the poller lifecycle defect. The CI log does not expose the precise internal HTTP socket/connection state, so no specific transport race or database outage is claimed.

## Repair

- A referenced, monotonic deadline now spans the entire polling operation. Every pending probe is raced against it, including one that never settles or ignores abort. The deadline is cleared and cancellation signalled on every exit; retries stay sequential.
- Default 60s deadline and existing 20s heartbeat, 30s fixture-run and 5s worker-restart limits are unchanged. HTTP probes still require the exact expected 200/503 status, retain a 3s request limit, and cancel unused bodies.
- Blocking Docker probes use the remaining deadline as their subprocess timeout with SIGKILL. JavaScript timers cannot interrupt `execFileSync`; this separate bound is necessary. A late result is never accepted as readiness.
- Failure reports include condition, attempt count, elapsed time, last outcome/error code/status, source location and allowlisted container state. Raw command arguments, environment, output, bodies and error causes are omitted. Diagnostics have 3s subprocess limits; cleanup has 10s per resource and reports failure instead of silently passing.
- Timeout throws through the outer failure handler, sets exit code 1 and reaches the existing disposable-resource cleanup. It no longer relies on a pending abort promise to keep the process alive.

## Verification

The eight focused tests use real ESM subprocesses so Vitest's event-loop handles cannot hide exit 13. They cover unreferenced abort/retry, a never-settling probe, deadline cleanup after success, repeated false results, redacted errors, stalled real localhost HTTP, exact 503-to-200 readiness and a blocking subprocess deadline.

Final local results:

| Check                                                      | Result                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| Original helper, standalone ESM reproduction               | Exit 13 reproduced on Node 22.23.3 and 26.11.1                  |
| Complete unit suite with coverage, Node 22.23.3            | **395 tests passed**, 26 files, including all 8 new regressions |
| Docker build                                               | Passed, `tessaloom:pr14`, Linux ARM64                           |
| Complete container smoke, Node 22.23.3                     | Passed, exit 0 after cleanup; worker restart 1,082ms            |
| Complete deployment smoke, Node 22.23.3                    | Passed, exit 0; restart count 0 → 1                             |
| ESLint, root/script type checks, Prettier, diff whitespace | Passed                                                          |
| Changed-file offline Gitleaks scan                         | No leaks                                                        |

The full container and deployment smokes also passed with the host Node 26.11.1. Container coverage retained the actual child UID/environment checks, Harness PATH positive/negative controls, worker heartbeat, fixture queue/SSE flow, backup/restore, secret redaction, worker restart, database outage/recovery, graceful shutdown and production fixture/root-identity rejection. Deployment coverage retained mounted-secret isolation, worker-only credentials, HTTPS/proxy headers, anonymous invite denial, backup/recovery and PID 1 restart.

The Node 22.23.3 host binary was downloaded from the official Node distribution and checked against its published SHA-256 before execution; project toolchain/dependencies were not modified. No application code or dependency changed, so unrelated browser/integration suites were not repeated.

Remote checks must pass on both push and pull_request after an authorized push; local ARM64 results do not certify GitHub's AMD64 runner. PR #14 must remain unmerged meanwhile.
