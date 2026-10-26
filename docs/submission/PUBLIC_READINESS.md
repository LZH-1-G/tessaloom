# Public repository readiness audit

Audit date: 2026-10-24. Repository visibility has not been changed. Public release still requires owner approval and review of historical documentation/data rights.

## Source and evidence integrity

- Root `LICENSE` contains the standard MIT grant, warranty disclaimer and 2026 LZH-1-G attribution. Public GitHub license detection remains a post-publication check.
- README now describes implemented M0–M10-B behavior, current demo modes and real-provider evidence limits. Old milestone reports remain historical evidence, not current status.
- Synthetic pages and exports explicitly say **FIXTURE — not real Qloo data**. Fixture facts never become Qloo facts when cached. A newly found projection bug in project sample overviews was fixed: the response now retains its fixture marker, so both the banner and the production read firewall still apply. Scripted output is not described as a real model evaluation.
- The historical Qloo capability report, the two-call synthetic DeepSeek report, and current fixture journeys are distinct evidence. No fresh Qloo call or full Qloo + DeepSeek E2E is claimed.
- `.gitignore` and `.dockerignore` exclude environment files, private deployment directories, dumps and test traces. Do not publish private configuration or browser traces: they can contain workspace/share credentials even when the product intentionally uses synthetic data.
- Selected submission screenshots show synthetic content and provenance labels. Review them personally before uploading. Existing historical research reports may contain normalized provider observations: their public-display/retention rights are not established by the MIT source license.

## Security checks

The acceptance report records exact executed checks. Full local Git history was scanned with Gitleaks 8.30.0 in a network-disabled read-only container: 28 existing commits, no leaks. Changed/new files are scanned separately before the checkpoint. An earlier approval-service usage-limit failure did not execute the scan; it was resumed through the normal approval mechanism once available, never bypassed.

A fresh production-dependency audit identified **GHSA-27r3-jxmh-p828**, a high-severity denial-of-service issue in `body-parser 2.3.0`, transitively included by the MCP SDK's Express dependency. A narrow workspace override pins **2.4.0**, the fixed release, and the lockfile records it. Tessaloom's public API is Next.js, not an Express body-parser endpoint; the transitive finding was still patched rather than ignored. [Maintainer advisory](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828).

Provider credentials remain worker-only. Mounted-secret file access is denied to both unprivileged children; only the supervisor reads files. Fake DeepSeek/Qloo/Anthropic sentinels are used in local deployment checks. Production fixture generation, anonymous paid generation, positive spending without authorization, and uncertain currency/pricing configuration remain blocked.

## Dependency license inventory

`DEPENDENCY_LICENSES.json` records the installed package manifests, versions, declared licenses and top-level notice filenames. It is a local installed-package inventory including development tooling and host-specific optional binaries, not a complete container SBOM or a claim that every entry ships in the browser. `pnpm licenses list` initially failed because an installed package index was missing; the manifest inventory is a read-only alternative and is described as such.

Observed licenses include MIT, Apache-2.0, ISC, BSD, MPL-2.0, LGPL-3.0-or-later, CC-BY-4.0, Python-2.0 and public-domain-style alternatives. They are **not all MIT**. In particular:

- `axe-core`, its Playwright integration and Lightning CSS declare MPL-2.0. Preserve their license and source notices; no third-party source files were modified by this task.
- Sharp's platform libvips package declares LGPL-3.0-or-later. The installed macOS package declares that license but supplied no license/notice file found in this audit. Binary notice/source-offer compliance is therefore not marked complete; review the upstream libvips distribution and corresponding Linux package before publishing an image. Do not infer binary redistribution readiness from the manifest alone.
- `caniuse-lite` declares CC-BY-4.0; retain attribution and license references.
- `argparse` declares Python-2.0; retain its supplied notice.
- Docker base-image OS packages, PostgreSQL, Caddy and the globally installed Qloo Harness have their own licensing and distribution terms. The locally inspected Harness 0.1.26 manifest declares MIT. The package-manifest inventory does not replace their notices or grant rights to Qloo data.

The MIT license covers Tessaloom's original source. Keep dependency notices in installed distributions; do not label bundled third-party software or provider data as exclusively MIT. Before publishing a downloadable image, complete an image-specific SBOM/notice review. Source publication and public demo hosting do not require publishing the image itself.

## Publication checklist (updated 2026-10-26, release branch `claude/release-validation`)

- [x] Full-history gitleaks (offline v8.30.0, all refs): no leaks. Working tree: findings only in gitignored `apps/web/.next` build output.
- [x] No provider tokens, application secrets or private database URLs tracked. The only credential-shaped URLs are `u:p@local` test strings and documented local placeholders. Environment examples (`.env.example`, `deploy/.env.example`, `deploy/northflank*.env.example`) contain placeholders and zero budgets only.
- [x] No personal identifiers tracked. Hardcoded local home paths were removed from tracked files; older commits still contain them (low sensitivity, history not rewritten).
- [x] No Qloo response data tracked ([data-rights review](DATA_RIGHTS_REVIEW.md)); real-data screenshots and exports are kept out of the repository.
- [x] Media: only our own synthetic-fixture screenshots. Fonts are SIL OFL, self-hosted at build.
- [x] No debug artifacts tracked (`test-results/`, `coverage/`, logs, dumps, `.env` files ignored).
- [x] MIT `LICENSE` at the root; GitHub already detects "MIT License" (verified via `gh repo view`).
- [x] README describes the verified state, setup from a clean checkout (fixture mode, no keys), live-mode variables, and the verification commands. CI covers lint/typecheck, unit, integration, Chromium/WebKit E2E, security (audit, gitleaks, osv-scanner, bundle scan) and the Docker image smoke on Linux AMD64. `main` at `a37afc6` is fully green.
- [ ] **Owner:** make the repository public, then confirm the License appears in the About section for a logged-out visitor and that README links resolve. CodeQL starts automatically once public.
- [ ] Review final deployment-image dependency notices if distributing that image publicly (not required for source publication).
