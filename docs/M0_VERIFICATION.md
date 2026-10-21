# M0 verification — 2026-10-21

This report includes the focused remediation of the independent review's **CHANGES REQUIRED** findings. All applicable local checks now pass, including the new supervised harness execution proof. The earlier smoke result did not prove that path; the new evidence supersedes it. M0 is ready for final targeted independent review and authorized PR CI. **Full milestone acceptance remains BLOCKED on green PR CI:** the owner has not authorized a commit, push, or PR. No remote CI or CodeQL result is claimed. M1 has not started.

## Scope and repository state

- Repository: `<repo-root>`.
- Branch: `codex/m0-foundation`; base HEAD `36e4102` (`docs: finalize Tessaloom architecture`).
- Existing uncommitted implementation was preserved and repaired in place. Nothing was committed, pushed, merged, staged, or switched to `main`.
- The index is unchanged; the final modified/untracked file list is retained in the inventory below.
- Node **22.23.3**, pnpm **10.34.7**, Next.js **16.4.2**, PostgreSQL **16**, official Qloo harness **0.1.26**.
- All twelve architecture documents were inspected in the original implementation session; M0 §3, §6 and TEST_PLAN §14 were rechecked on resume. The owner's M0-only instruction overrides §6's suggestion to continue immediately to M1.
- All eight planned product modules remain in the README and architecture. This scaffold implements no business logic, domain schema, migration, job, Qloo call, or runtime LLM call. No provider credentials were required or used.

## Components implemented

| M0 requirement | Implementation |
| --- | --- |
| Monorepo and toolchain | Nine pnpm workspace projects; pinned Node/pnpm; strict shared TypeScript; six package stubs |
| Web | App Router, Tailwind, shadcn manual initialization (`components.json`, theme, aliases, `cn`), placeholder page; standalone output and copied static assets |
| Worker | Bundled Node entry point, environment validation, idle lifecycle, idempotent SIGTERM/SIGINT shutdown |
| Shared checks | Recommended core JavaScript and TypeScript/React/hooks/accessibility presets, import boundaries, Prettier, Vitest presets and coverage; strict TypeScript `checkJs` over every `scripts/*.mjs` |
| Environment | Zod web/worker schemas; web rejects every `*_API_KEY` and migrator URL; production rejects fixtures; errors contain variable names only |
| Health | `/api/health` returns `{status:"ok",version:"0.0.0"}`; readiness returns `{db:true}`/200 or `{db:false}`/503 with bounded DB checks and no-store |
| Supervisor | Built-ins only; three roles; ADR-017 allowlists plus generated PATH; exponential 1–30 second backoff; sixth crash within five minutes exits 1; signals forwarded to process groups; 25 second grace; root requires configured non-root child UID/GID before any spawn |
| Container | Multi-stage Node 22 slim image; tini; official globally installed harness; web UID 10001, worker UID 10002; worker-owned harness home mode 0700 |
| Local services | PostgreSQL 16 Compose service and optional single application service running both processes |
| CI | Lint/type-check, unit coverage, PostgreSQL integration, runtime/browser smoke, audit/Gitleaks/OSV/bundle scan, CodeQL, Docker build/smoke; Dependabot |

The finalized single-service deployment architecture is unchanged. ADR-016 now confirms the existing Fly.io + Neon engineering target after checking published plans; no hosting was provisioned. Actual hosted isolation and sizing remain M10.

## Independent review remediation

| Finding | Resolution | Regression evidence |
| --- | --- | --- |
| **HIGH-1: supervised children lacked PATH** | `buildChildEnv` always sets `CHILD_PATH`, derived from `process.execPath`'s directory plus fixed system directories, deduplicated. The parent PATH is discarded. Docker's generated value is `/usr/local/bin:/usr/bin:/bin`. No other variables were added to the inherited allowlists. | Both roles tested with an attacker-controlled parent PATH, with PATH absent, and with `LD_PRELOAD` / `NODE_OPTIONS` rejected. Final container probe reads the live supervised worker's `/proc/<pid>/environ`, runs under its observed UID/GID, and invokes `qloo --version` by name with that exact environment. It asserts the `/usr/bin/env node` shebang and includes a missing-PATH negative control. |
| **MEDIUM-1: root could spawn root children with missing UID settings** | All selected identities are validated before logging or spawning. Root requires positive non-root UID/GID values in the OS-supported range; GID defaults to UID. Both selected UIDs must differ. Missing configuration fails with exit 1; Docker's existing UID defaults remain valid. An already non-root local supervisor retains its current identity. | Eight unsafe root configurations are rejected without any spawn, including partial configuration, zero/out-of-range IDs, zero GID, and equal UIDs. A positive test verifies actual spawn options. Container checks remove each selected role's UID setting and assert exit 1, a configuration event, and no child-start event. |
| **MEDIUM-2: insufficient JavaScript lint coverage** | Added direct exact pins `@eslint/js@9.39.5` and `globals@14.0.0`, already present transitively. Core recommended rules and Node globals apply to `.mjs`; existing TS/React/hooks/a11y/boundary rules remain. React version resolves from `apps/web` through `createRequire`. New `tsconfig.scripts.json` checks all scripts with strict `checkJs`, using JSDoc types instead of suppressions. | Probes detect undefined identifiers, unreachable code, duplicate keys, and constant conditions in `.mjs`, while accepting Node globals. A configuration probe verifies the actual web React version. Existing TS/React/hooks/a11y/import-boundary probes still pass. |
| Weak environment-error assertion | The test now requires a throw naming `DATABASE_URL`, then independently asserts the sentinel is not in that error. | The test fails if parsing unexpectedly succeeds. |
| Weak production-fixture container assertion | Require exit 1 and `supervisor_config_invalid` with reason `production_fixture_forbidden`, plus no child start. | Unrelated startup failures can no longer satisfy the production-fixture check. |

The harness probe starts only the diagnostic launcher with an absolute Node path. It then resolves `qloo` by name and executes the harness's Node shebang using the live worker environment. It does not substitute `buildChildEnv`, the Docker exec environment, a shell, or an absolute harness path for that execution. This proves the supervised environment and UID work without adding provider initialization to the M0 worker. Only `--version` is invoked; no Qloo or LLM credential is used. Dummy sentinels remain limited to the isolation tests.

ADR-017, SECURITY §3/§7, and the architecture's isolation summary now describe generated PATH and fail-closed root identities. This tightens root safety within the existing one-service design; it does not advance M1 or change deployment topology.

## Commands and observed results

Commands below ran from the repository root. On this machine the system Node/pnpm differed from the project pins, so local checks used:

```sh
export PATH=<local-toolchain>/node_modules/node/bin:<local-toolchain>/node_modules/.bin:$PATH
```

Machine-specific paths in this report and in `evidence/m0/` are replaced with placeholders: `<repo-root>` (repository checkout), `<local-toolchain>` (directory holding the pinned Node 22.23.3 and pnpm 10.34.7), `<pnpm-store>` (local pnpm content-addressable store), and `<working-tree-snapshot>` (temporary copy of tracked and untracked files used for the Gitleaks scan).

A clean review environment can instead install the `.nvmrc` version and use the pinned `packageManager`.

| Exact command | Status | Actual result |
| --- | --- | --- |
| `pnpm install --store-dir <pnpm-store>` | PASSED | Added explicit pins for already-resolved core ESLint rules and Node globals; no new transitive packages |
| `pnpm install --frozen-lockfile --store-dir <pnpm-store>` | PASSED | All 9 projects; lockfile up to date; no resolution changes |
| `pnpm lint` | PASSED | ESLint and Prettier passed |
| `pnpm typecheck` | PASSED | Root, web, worker, and strict `tsc -p tsconfig.scripts.json` checks passed |
| `pnpm test:unit --coverage` | PASSED | 62 tests, 3 files; environment parser 100% lines/branches; aggregate measured files 89.83% lines and 81.25% branches |
| `pnpm test` | PASSED | Acceptance-command rerun: the same 62 unit tests passed |
| `DATABASE_URL=postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom pnpm test:integration` | PASSED | 3 tests against real PostgreSQL 16: independent liveness, DB-ready 200, unreachable-DB 503 |
| `QLOO_API_KEY=m0-qloo-secret-sentinel ANTHROPIC_API_KEY=m0-llm-secret-sentinel DATABASE_URL_MIGRATOR=m0-migrator-secret-sentinel pnpm build` | PASSED | Production standalone web and bundled worker built with nonfunctional canaries in the build environment |
| `pnpm check:bundle` | PASSED | 185 output files checked; no canary values and no provider-key names in browser assets |
| `pnpm test:runtime` | PASSED | 6 real-process tests: standalone deny-list/fixture rejection and worker shutdown for both signals |
| `pnpm test:e2e` | PASSED | 2 tests: Chromium and WebKit; HTTP 200, placeholder rendering, zero serious/critical axe violations |
| `pnpm audit --prod --audit-level=high` | PASSED | No known vulnerabilities found; transient registry ECONNRESET retries recovered |
| OSV command below | PASSED | Final lockfile: 474 packages, no issues found; no advisory suppressions |
| Gitleaks commands below | PASSED | Source-only working tree and full 2-commit history: no leaks found |
| `docker build -t tessaloom:m0 .` | PASSED | Rebuilt image includes the review fixes; Linux arm64 on Docker Desktop |
| `pnpm test:container` | PASSED | Live worker UID/GID 10002: qloo 0.1.26 via Node shebang; missing-PATH negative control; root identity rejection; ready 200; env/home isolation; 1159 ms restart; clean shutdown and explicit production-fixture rejection |
| `docker compose config --quiet` | PASSED | Compose configuration valid |
| `git diff --check` | PASSED | No whitespace errors |
| PR CI, including hosted CodeQL | BLOCKED | No push/PR authorized; workflow configured but not executed remotely |

The review remediation increased the unit count from 45 to **62**: two controlled-PATH cases, eight unsafe root identity configurations, one valid root spawn-options case, and six core-JavaScript/Node-global/React-version probes. Earlier environment-prototype, invalid-URL, TS/React/hooks/a11y, fixture-guard, boundary, restart, and name-only logging tests remain intact.

The browser checks execute the generated standalone server through the actual supervisor. Screenshots were visually inspected: [Chromium](evidence/m0/placeholder-chromium.png), [WebKit](evidence/m0/placeholder-webkit.png). These are placeholder-only smoke checks, not tests of future product flows.

Final image ID: `sha256:65647cd3e65781e6acd4fa5a6ceb27c690dd685fc532427e344d88a7b896d10b` (`linux/arm64`). The smoke script invokes `docker run --rm tessaloom:m0 qloo --version`, then separately verifies execution under the live supervised worker environment and UID/GID 10002. The worker restart took **1159 ms** with web liveness continuing. All temporary smoke containers and their network were removed. The existing local Compose PostgreSQL service is left running and healthy with its volume preserved.

Retained evidence: [container smoke](evidence/m0/container-smoke.txt), [unit](evidence/m0/unit.txt), [runtime](evidence/m0/runtime.txt), [browser](evidence/m0/browser.txt), [lint](evidence/m0/lint.txt), [type-check](evidence/m0/typecheck.txt), [OSV](evidence/m0/osv.txt), [working-tree Gitleaks](evidence/m0/gitleaks-working-tree.txt), [history Gitleaks](evidence/m0/gitleaks-history.txt). The container log includes environment names, IDs, permissions, timing, harness version, and boolean assertions only. It verifies the web process cannot read `/proc/<worker>/environ` or list the worker's private harness directory, with no extra Linux capabilities granted.

### Security scan commands

```sh
docker run --rm --cap-drop ALL --security-opt no-new-privileges \
  -v "$PWD/pnpm-lock.yaml:/scan/pnpm-lock.yaml:ro" \
  ghcr.io/google/osv-scanner:v2.3.0 scan source --lockfile /scan/pnpm-lock.yaml

docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges -v "$PWD:/repo:ro" \
  zricethezav/gitleaks:v8.30.0 git /repo --redact --config /repo/.gitleaks.toml

docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  -v <working-tree-snapshot>:/scan:ro \
  zricethezav/gitleaks:v8.30.0 dir /scan --redact --config /scan/.gitleaks.toml
```

The working-tree snapshot is built from `git ls-files --cached --others --exclude-standard -z`, copying existing files with their relative paths. It includes untracked source/configuration and excludes ignored `.env`, installed dependencies, generated builds, and caches. The history scan alone would not cover these uncommitted files.

`.gitleaks.toml` retains the default rules and adds a high-entropy Qloo assignment rule. Three anchored, exact-value exceptions cover only known nonfunctional test sentinels: the Qloo smoke sentinel and the two test pepper placeholders. There are no whole-file, test-directory, key-name, or generic-placeholder exemptions. No real credential or vulnerability was suppressed. Gitleaks runs offline with read-only mounts; OSV receives only the public package lockfile.

### Vulnerability remediation

Initial OSV status: **FAILED** for **GHSA-vfj7-8cjw-p6xm / CVE-2026-93687**, high severity (CVSS 8.7). The installed affected version was `braces@3.0.3`; the advisory covers versions `<=3.0.3` and listed no patched version when checked. Deeply nested patterns can exhaust the stack. [Advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

The only resolved chain was a development dependency:

```text
eslint-config-next@16.4.2
  → @next/eslint-plugin-next@16.4.2
  → fast-glob@3.3.1
  → micromatch@4.0.8
  → braces@3.0.3
```

Remediation removed `eslint-config-next` and that chain, retaining direct recommended presets from `typescript-eslint@8.72.0`, `eslint-plugin-react@7.37.5`, `eslint-plugin-react-hooks@7.1.1`, and `eslint-plugin-jsx-a11y@6.10.2`, plus the architecture restrictions. Regression tests exercise the actual lint engine. The final lockfile contains none of `braces`, `micromatch`, `fast-glob`, `eslint-config-next`, or `@next/eslint-plugin-next`. Next-specific advisory/performance lint rules are no longer supplied by that optional preset; the M0-required correctness, accessibility, and boundary rules remain active. Runtime Next.js and the deployment architecture are unchanged.

### Failures found and repaired

| Earlier failure | Correction and verification |
| --- | --- |
| Invalid URL caused a thrown `new URL()` exception inside Zod refinement | Non-throwing PostgreSQL protocol refinement; invalid and non-PostgreSQL URL tests pass |
| Zod record validation rejected Node's exotic `process.env` object | Validate a plain snapshot; regression test and built-process tests pass |
| Next instrumentation failure left a listener serving 500 | Explicit safe error log and exit 1; real standalone boot tests pass |
| Worker could receive a signal before handlers were registered | Register handlers before announcing readiness; both real signal tests pass |
| Browser runner could leave detached children | Configure graceful supervisor SIGTERM shutdown; browser rerun passes |
| Container root inspector received EACCES after child UID changes | Inspect each child's environment under its own UID, without adding capabilities; verify web access to worker environment is denied |
| Gitleaks flagged dummy test strings | Exact-value exceptions above; both scans pass |
| OSV found vulnerable development dependency | Removed affected dependency chain; full-lockfile OSV passes |

## M0 acceptance checklist

| IMPLEMENTATION_PLAN §3 criterion | Status | Evidence |
| --- | --- | --- |
| Frozen install, lint, type-check, unit tests | PASSED | Commands/results above; `pnpm test` aliases the same unit suite |
| Docker build and in-image harness version ≥0.1.26 | PASSED | Final rebuilt image; qloo 0.1.26 also executes with the live worker environment and UID/GID |
| Standalone build serves `/api/health` with 200 | PASSED | Production build and two real-browser smoke tests |
| Env deny-list and production fixture guard unit tests | PASSED | Unit and real standalone process checks |
| Supervisor allowlists, fake-timer restart policy, name-only logs | PASSED | Unit suite plus real-container inspector run |
| Container + PostgreSQL ready 200, web environment scrubbed, worker restart | PASSED | Final image smoke: 1159 ms restart; no provider keys in web; worker environment/home inaccessible to web |
| CI green on the PR | BLOCKED | No commit/push/PR authorization, so no CI link exists |

## Remaining risks and review handoff

- No applicable local check remains FAILED or BLOCKED. Full M0 sign-off must wait for green PR CI and targeted independent review. M1 requires separate owner approval.
- ESLint 9.39.5 emits an upstream end-of-support warning; it is retained for the installed React plugin's supported peer range. Audit and OSV are clear for the pinned dependency set at verification time. Reassess compatibility when upgrading tooling; this warning is not presented as a vulnerability waiver.
- Lockfile scans do not constitute a container OS or globally installed harness dependency audit. The optional Trivy image scan was not run. CodeQL has not run locally or remotely.
- The final container was tested on local Linux arm64; the workflow's Ubuntu runner must independently verify its Linux amd64 build. Browser coverage is a desktop Chromium/WebKit smoke, not a full cross-device acceptance suite.
- Process-level isolation has the residual root/container-compromise risk accepted in ADR-017. The supervisor necessarily receives the parent secrets. Local execution without distinct UIDs verifies filtering but does not provide Linux process isolation; the Docker tests exercise UID isolation.
- Server-side output necessarily includes forbidden variable **names** used by the required boot validator. The bundle check scans browser assets for names and all application output for injected canary **values**. This is the documented interpretation of the broad bundle-grep instruction, not removal of the deny-list.
- Readiness is DB-only in M0; heartbeat/job/harness readiness starts with M4. Production provider-key enforcement starts with the adapters in M2/M3. Migration and DB-role work remains M1. Live integration is unverified by design.
- No cloud resources, domain, billing, or provider credentials were configured. ADR-016's vendor confirmation is an engineering target only.
- **Readiness connection pooling:** M0 creates a short-lived PostgreSQL client per readiness check. Evaluate pooling, health-check frequency, and managed-DB connection limits before hosted operation; no pool/schema work was added in this remediation.
- **Dependency and image pinning:** JavaScript dependencies and the harness use exact versions and a frozen lockfile. Container base/PostgreSQL/scanner image tags and Action major tags can move; immutable digest/SHA pinning and update policy remain a hardening follow-up.
- **Local-path sanitization:** the development launcher still needs the developer's tool PATH, and the controlled supervised PATH trusts the directory of the running Node binary. Review ownership and writable path entries before local live credentials are used. Machine-specific paths in this report and its evidence have been replaced with placeholders. The Docker executable directories are root-owned.
- **LLM gateway dependency direction:** the lint rule allows `llm-gateway → core` only, matching ARCHITECTURE §3.2. IMPLEMENTATION_PLAN M3 says the gateway calls the output validators in `packages/agent`, which would require `llm-gateway → agent`, an import the rule currently forbids. Resolve this before M3: either inject the validators from the worker into the gateway (no new dependency), or explicitly allow `llm-gateway → agent` and update ARCHITECTURE §3.2. This remediation intentionally does not change package boundaries.

For independent Claude Code review, start with `packages/config/env.ts`, `scripts/start.mjs`, `Dockerfile`, `scripts/container-smoke.mjs`, `packages/config/eslint.mjs`, the tests, and `.github/workflows/ci.yml`. Review the uncommitted working tree against `36e4102`, rerun the commands above, and keep M1 out of scope.

## File inventory

This focused remediation changed `scripts/{start,container-smoke,check-bundle,dev}.mjs`, `packages/config/eslint.mjs`, `tests/unit/{supervisor.test.mjs,env.test.ts,boundaries.test.ts}`, `package.json`, and `pnpm-lock.yaml`; added `tsconfig.scripts.json`; updated `docs/{DECISIONS,SECURITY,ARCHITECTURE,TEST_PLAN,M0_VERIFICATION}.md`; and refreshed/added the linked M0 evidence files. Existing application code and package stubs were preserved.

The final inventory is supplied in [evidence/m0/changed-files.txt](evidence/m0/changed-files.txt). It lists every modified or untracked deliverable relative to the repository root, including this report and retained screenshots. Generated dependency/build/test directories are ignored and are not deliverables.
