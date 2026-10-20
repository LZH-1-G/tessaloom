# Tessaloom — Security, Privacy, and Credential Management

> **Status:** v1.1 · 2026-10-20 (review: process-level isolation in a single service, ADR-017; LLM key requirements, ADR-018)
> **Baseline:** OWASP ASVS 4.0 Level 1 (selected Level 2 controls noted) · Qloo Hackathon Kit `SAFE_USE.md`, `API_ACCESS.md`, `SECURITY.md`
> **Related:** [ARCHITECTURE.md](ARCHITECTURE.md) · [DATABASE_SCHEMA.md §8](DATABASE_SCHEMA.md#8-secret-protection-and-data-minimization) · [TEST_PLAN.md §9](TEST_PLAN.md#9-security-checks)

**Reporting vulnerabilities in Tessaloom:** please use GitHub private vulnerability reporting on this repository. Do not open public issues for security problems.

---

## 1. Security objectives

1. **Protect the Qloo event credential and the LLM API key.** They are individually attributable, quota-bearing, and billable.
2. **Never mislead users about data origin.** No fixture or mock data may be presented as Qloo data.
3. **Collect no personal data,** and send no personal data to Qloo or the LLM beyond the user's own brief text.
4. **Keep each workspace's projects isolated.** Share links expose exactly one scoped, read-only view.
5. **Resist prompt injection and abuse** that could exhaust quotas or produce harmful output.

---

## 2. Threat model (STRIDE summary)

| Asset | Threat | Vector | Control |
|---|---|---|---|
| `QLOO_API_KEY` | Disclosure | Committed to git; client bundle; logs; demo video; MCP config; shell history; read from the web process in the shared container | Worker-only env via the supervisor allowlist + UID separation (§3); gitleaks in CI and pre-commit; never `--api-key`; log redaction; recording checklist (§10) |
| `ANTHROPIC_API_KEY` (LLM provider key) | Disclosure / cost abuse | Same as above; prompt injection that loops | Worker-only env; per-run and global cost caps; bounded loops; a Console workspace spend limit (ADR-018) |
| Qloo quota | Exhaustion (DoS) | Anonymous users starting many runs; retry storms | Workspace/IP rate limits, daily guards, bounded retries, cache, replay samples |
| Workspace data | Spoofing / IDOR | Guessing project IDs | All queries scoped by `workspace_id` from the cookie; UUIDv7 IDs are not treated as authorization; authorization tests |
| Share links | Token guessing / leakage | Brute force; referrer leakage | 256-bit tokens, stored hashed; `Referrer-Policy: no-referrer` on share pages; expiry and revocation; rate-limited lookups |
| Evidence integrity | Tampering / repudiation | The LLM fabricates Qloo facts | Deterministic evaluators; DB `CHECK` constraints; JSON-pointer verification against snapshots; append-only tables |
| Users | Harmful or misleading content | Model output with sensitive inferences | Safe-use validator; copy guidelines; refusal handling |
| Web app | XSS / CSRF / clickjacking | User text rendered in the UI; cross-site POST | React escaping; no `dangerouslySetInnerHTML`; sanitized Markdown subset; CSRF token + Origin check; CSP `frame-ancestors 'none'` |
| Worker host | Command injection | Arguments passed to `qloo exec/api` | `execFile` without a shell; allowlisted workflows and flags; Zod-validated arguments; temp JSON files with random names |
| Supply chain | Malicious dependency | npm packages | Lockfile; `pnpm audit` / OSV scanner; pinned harness version; Dependabot; minimal dependencies |

---

## 3. Credential management

### 3.1 Inventory

| Secret | Where it lives | Who can read it | Rotation |
|---|---|---|---|
All runtime secrets live in **one** platform secret store: the single deployment service (ADR-017). Isolation between processes comes from the supervisor's **per-process environment allowlists** and, when the platform allows a root start, **separate Unix UIDs**.

| Secret | Where it lives | Which process receives it | Rotation |
|---|---|---|---|
| `QLOO_API_KEY` | Service secret store (hosting platform) and the local developer shell / `qloo setup --qloo` private config | **Worker** + its `qloo mcp` child only | On exposure: stop using it and request revocation (§9). Otherwise as organizers direct. |
| `ANTHROPIC_API_KEY` (or another provider's key) | Service secret store | **Worker** only | On exposure; otherwise after the hackathon |
| `DATABASE_URL` (app role) | Service secret store | Web and worker | After the hackathon or on exposure |
| `DATABASE_URL_MIGRATOR` | Platform release / pre-deploy command only | Migration step only (in no child allowlist) | Same |
| `SESSION_SECRET` (≥ 32 random bytes) | Service secret store | **Web** only | Rotation invalidates workspace cookies; acceptable after judging |
| `SHARE_TOKEN_PEPPER` | Service secret store | **Web** only | Rotation invalidates share links |
| `ADMIN_TOKEN` (optional diagnostics) | Service secret store | **Web** only | Any time |

### 3.2 Rules

1. **Never** commit secrets. `.env*` files other than `.env.example` are git-ignored (the existing `.gitignore` already ignores `.env` patterns; verify during M0). `.env.example` contains placeholders only.
2. **Never** place the Qloo or LLM key in the web app, the browser bundle, `NEXT_PUBLIC_*` variables, MCP client config files, or the database. The `apps/web` environment schema **rejects** `QLOO_API_KEY` and `*_API_KEY` at boot (an explicit deny check).
3. **Never** pass `--api-key` to `qloo`; the kit warns it leaks to shell history. The harness reads `QLOO_API_KEY` from the environment.
4. **Spawn `qloo mcp` with `env: process.env`** (required for the key to reach the child process). No other process receives the environment.
5. **Process-level isolation in one service (ADR-017):**
   - The supervisor (`scripts/start.mjs`) passes each child **only** its allowlisted variables. The web process never receives `QLOO_*` secrets or `*_API_KEY`.
   - The web env schema additionally **rejects** these variables at boot (defense in depth).
   - When a root container start is possible, `web` and `worker` run under distinct UIDs (`tl-web`, `tl-worker`), so the web process cannot read `/proc/<worker-pid>/environ`. `QLOO_HOME` is owned by `tl-worker` with mode `0700`.
   - The supervisor logs variable **names** only.
   - **Residual risk:** a container-level compromise could expose worker secrets. It is mitigated by provider spend limits, the Qloo quota guard, and fast revocation (§9). If stronger isolation is needed, the same image can be split into two services via `TL_ROLE`.
6. **Local development** uses `QLOO_MODE=fixture` by default. Live mode requires the developer to export `QLOO_API_KEY` in their own shell session or use `qloo setup --qloo`.
7. **CI** never receives the Qloo key, except in an optional, manually dispatched `live-smoke` workflow restricted to a protected GitHub environment with required reviewers (the owner). That workflow's logs are reviewed for redaction before any sharing.
8. **Coding assistants (Claude Code, Codex)** are not given secrets. The kit warns that `qloo explore` sends files it reads to the model provider, so secrets must stay out of the project folder.

### 3.3 Detection

- **gitleaks** runs as a pre-commit hook (optional locally) and as a required CI job, with a custom rule for likely Qloo key patterns. The exact format is unknown, so it uses a generic high-entropy rule plus the variable-name context `QLOO_API_KEY=`.
- **GitHub secret scanning and push protection** are enabled when the repository becomes public.
- The **pino logger** redacts the paths `*.apiKey`, `*.api_key`, `headers.authorization`, `headers["x-api-key"]`, `env.*`, and `*.QLOO_API_KEY`. Unit tests verify the redaction.

---

## 4. Identity, access, and share links

### 4.1 Anonymous workspaces

- On the first request, the web process issues the cookie `tl_ws`: 32 random bytes, base64url-encoded, with `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`.
- The server stores only `HMAC-SHA-256(secret, SESSION_SECRET)`. A database leak therefore does not reveal usable workspace secrets.
- Every repository method takes a `workspaceId` derived server-side from the cookie. Route handlers never accept `workspaceId` from the client.
- **Workspace recovery:** a "Workspace key" export in settings (S) lets a user copy their secret and restore it in another browser. The UI explains that anyone with the key can access the projects.

### 4.2 Authorization matrix

| Resource | Owner workspace | Share token (scope matches) | Anyone else |
|---|---|---|---|
| Project read | ✔ | ✔ (project scope) | ✖ (404) |
| Experiment / hypotheses / evidence / graph read | ✔ | ✔ (project or experiment scope, if the experiment belongs to the shared target) | ✖ |
| Evidence trace (redacted request, envelope summary, pointer value) | ✔ | ✔ | ✖ |
| Raw snapshot download | ✔ (debug, S) | ✖ | ✖ |
| Blueprint read / export | ✔ | ✔ (blueprint or project scope) | ✖ |
| Any mutation, run control, confirmation | ✔ | ✖ | ✖ |
| Sample projects (system workspace) | Read-only via fork | — | Fork creates a copy owned by the caller |

Unauthorized access returns **404**, not 403, to avoid confirming that a resource exists.

### 4.3 Share links

- The token has 32 random bytes and is shown once at creation. The database stores `sha256(token ‖ SHARE_TOKEN_PEPPER)`.
- Expiry defaults to 30 days, with a maximum of 90. Revocation takes effect immediately.
- Share pages send `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, and `Cache-Control: private, no-store`.
- Token lookups are rate-limited (30/min per IP-hash) to make brute force impractical.

---

## 5. Data privacy

| Principle | Implementation |
|---|---|
| Data minimization | No accounts, names, emails, or analytics trackers. No IP storage in the database. |
| Purpose limitation | Briefs are used only to run the user's experiments |
| What goes to Qloo | **Only** confirmed public cultural entity/tag identifiers, search text for entity names, localities chosen for venues, and aggregate parameters (for example an age band). **Never** brief free text, notes, or anything personal. This follows kit SAFE_USE: *"Do not send names, email addresses, device identifiers, account IDs, location histories, or other personal data to Qloo."* |
| What goes to the LLM provider | Brief content, resolved entity data, and evidence facts. A UI notice tells users this. |
| Aggregate-only interpretation | Qloo results are presented as aggregate affinities, never as claims about individuals, sensitive traits, or eligibility decisions (SAFE_USE). This is enforced by the safe-use validator and copy guidelines. |
| Retention | [DATABASE_SCHEMA.md §7](DATABASE_SCHEMA.md#7-data-retention) |
| Deletion | "Delete project" (hard delete via cascade) and "Delete workspace" (hard delete of everything) actions. Both are irreversible and confirmed by typing the project name. |
| Third-party data storage | Storing Qloo responses is limited to what the product needs (traceability, cache, samples), per kit API_ACCESS: *"Cache only what your project needs."* A terms review is **pending** (R-08). |

---

## 6. LLM and prompt-injection controls

| Risk | Control |
|---|---|
| Instructions hidden in the brief ("ignore previous instructions…") | Brief text is passed as a **JSON data block** inside delimiters, and the system prompt states that the data block is untrusted content. Role outputs are schema-constrained, and no role has side-effecting tools. The worst case is a bad hypothesis, which deterministic validators still catch. |
| Instructions inside Qloo results (for example in entity names or descriptions) | Same data-block treatment. Entity names are rendered as text only. |
| The model invents Qloo facts | `EntityGroundingValidator`, `CitationValidator`, `NumericFidelityValidator`, and DB constraints ([AGENT_WORKFLOW.md §13](AGENT_WORKFLOW.md#13-evidence-validation-and-hallucination-prevention)) |
| The model triggers unbounded Qloo usage | The LLM never calls Qloo. Proposals are checked against an allowlist and the budget by the orchestrator. |
| Cost blow-up | Per-run token and USD caps; global daily cap; `max_tokens` per call; at most 1 repair retry |
| Harmful or sensitive outputs | Safe-use validator + provider safety (refusal handling) + output copy rules. Refusals produce a neutral message and are never auto-retried in a loop. |
| Exposing chain-of-thought | Thinking content is not requested for display and not stored. Only `decisionSummary` output fields are shown. |
| Rendering model text | Model text is rendered as plain text or a sanitized Markdown subset (no raw HTML, links limited to `https:` with `rel="noopener noreferrer nofollow"`) |

---

## 7. Web application security

| Control | Setting |
|---|---|
| Transport | HTTPS only; HSTS `max-age=31536000; includeSubDomains` |
| CSP | `default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'unsafe-inline'` (Tailwind/Radix inline styles are allowed; to be reviewed); `img-src 'self' data:`; `connect-src 'self'`; `font-src 'self'`; `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'` |
| Other headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on share pages), `Permissions-Policy: camera=(), microphone=(), geolocation=()` |
| CSRF | Double-submit token header `X-Tessaloom-CSRF` + `Origin`/`Host` check on all mutations; SameSite=Lax cookies |
| Input validation | Zod at every API boundary; length limits as in [API_CONTRACTS.md](API_CONTRACTS.md); JSON body limit 64 KB |
| Rate limiting | Run-starting endpoints: 6/min per workspace, 20/min per IP-hash; other endpoints: 60/min per workspace; daily live-run allowance per workspace |
| Error handling | Generic user messages; internal details only in logs with a `requestId`; no stack traces in responses |
| Dependencies | Lockfile committed; `pnpm audit --prod` and OSV scanning in CI; Dependabot weekly; harness version pinned |
| Container | `tini` as PID 1; the supervisor spawns the children as non-root users (separate UIDs when possible); read-only root filesystem where feasible (writable `QLOO_HOME` and `/tmp`); minimal base image; no SSH |
| Database | TLS required; least-privilege roles ([DATABASE_SCHEMA.md §8](DATABASE_SCHEMA.md#8-secret-protection-and-data-minimization)); no direct public access other than the provider's TLS endpoint, with an IP allowlist where supported |

---

## 8. Integrity of displayed data

- **The fixture firewall:**
  - `FixtureTransport` throws at construction when `APP_ENV=production`;
  - the production boot check refuses `QLOO_MODE=fixture`;
  - the API serializer drops or blocks `DEVELOPMENT_FIXTURE` records in production;
  - an ESLint import boundary stops live transports from importing fixtures;
  - E2E tests assert that the fixture banner is visible in fixture mode, and an integration test asserts the production guard.
- **No silent substitution:** failed live requests produce `ERROR` outcomes and INCONCLUSIVE claims, which are visible to the user.
- **Append-only evidence:** the database role lacks `UPDATE` on evidence and snapshot tables.

---

## 9. Incident response

| Incident | Immediate action | Follow-up |
|---|---|---|
| Qloo credential exposed (commit, log, video, screenshot) | 1. Stop using the key: remove it from the worker secrets and stop the worker. 2. Per the kit's SECURITY.md, email **ian@qloo.com** to have it revoked, identifying the credential **by participant name only, never including the key**. 3. Purge it from git history if committed (`git filter-repo`) and force-push only with the owner's approval. | Record the event in DECISIONS.md (without the secret). Request a replacement through the kit's support channel. |
| LLM key exposed | Revoke it in the provider console; rotate; check usage for abuse | Lower the global spend cap until resolved |
| Quota exhaustion or abuse | The quota guard is already active; tighten rate limits; temporarily disable new live runs (feature flag `LIVE_RUNS_ENABLED=false`) | Samples remain available |
| Data integrity bug (wrong provenance) | Hide affected views behind a maintenance flag; fix; add a regression test | Disclose in the README's known limitations if it was public |
| Vulnerability report | Acknowledge within 72 h during the event period | Fix, credit the reporter if they wish |

Public support channels (GitHub Discussions in the kit repository) must **never** include keys, full request headers, or private source, per the kit's SUPPORT.md.

---

## 10. Demo, recording, and submission hygiene

- [ ] Record demos in **REPLAY** mode or with a dedicated browser profile; no terminal windows showing environment variables.
- [ ] No `qloo setup --status` output on screen unless redacted.
- [ ] No developer tools showing request headers.
- [ ] Screenshots reviewed for keys, tokens, share-link tokens, and personal data before upload. The kit's SUBMISSION.md requires *"a short demo or screenshots that contain no credential or personal data."*
- [ ] The repository is scanned with gitleaks over its **full history** before being made public.
- [ ] `.env.example` contains placeholders only.

---

## 11. Security acceptance criteria

These are tested per [TEST_PLAN.md §9](TEST_PLAN.md#9-security-checks):

1. gitleaks finds 0 secrets across the full history at submission.
2. The web build output (`.next/`) contains no `QLOO_API_KEY` or LLM key strings; this is checked with grep in CI.
3. Cross-workspace access tests return 404 for every resource type.
4. Share tokens give read-only access to their scope only; mutations return 403/404.
5. The production boot with `QLOO_MODE=fixture` fails; the fixture serializer guard passes.
6. CSP and security headers are present on all pages (Playwright header assertions).
7. `pnpm audit --prod` shows no high or critical vulnerabilities without a documented exception.
8. In the running container, the web process environment contains no `QLOO_API_KEY` or `*_API_KEY`. Verified by the supervisor allowlist unit test and a container smoke check of `/proc/<web-pid>/environ` (TEST_PLAN §9).
