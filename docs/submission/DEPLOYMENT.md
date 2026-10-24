# Deployment readiness and hosting decision

Reviewed 2026-10-24. No account was created, no host ordered or provisioned, and no public service deployed. Oracle support is not a dependency for completing the code, documentation or local acceptance work.

## Decision

Keep the existing M10-B topology: a single Linux VM running Caddy, the supervised Next.js/worker container, and PostgreSQL with durable volumes. It supplies HTTPS, long-lived workers, worker-only secrets, restart recovery and read-only samples with minimal architectural change. [M10-B operations](../M10B_DEPLOYMENT.md) remains the detailed runbook; this document updates the submission path and provider choice.

No currently verified, immediately available **$0 account entitlement** meets every requirement. Oracle remains a conditional option, not a launch commitment. If the owner wants a deadline-oriented paid fallback, review Hetzner CX23; do not purchase it until the owner approves the final checkout total.

| Option                | Official current limits / terms                                                                                                                                                                                                                                                               | Fit for this application                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oracle Always Free A1 | Official Free Tier documentation states 1,500 OCPU-hours and 9,000 GB-hours monthly, equivalent to 2 OCPUs / 12 GB; 200 GB combined boot/block storage. Home-region capacity and account entitlement apply; idle instances may be reclaimed.                                                  | Best conditional zero-cost fit for existing ARM64 Compose architecture. Owner's registration is pending. No capacity, free-billing entitlement or uptime is confirmed. |
| Render Free           | Web services sleep after inactivity; no persistent disk on free web services, no free worker service type. Free PostgreSQL is 1 GB and expires after 30 days.                                                                                                                                 | Does not satisfy a persistent worker plus durable judging-period operation without paid components and architectural changes.                                          |
| Koyeb Free            | One web instance, 512 MB RAM, 0.1 vCPU, 2 GB local SSD; no Worker Services or persistent Volumes; scales to zero after one hour without traffic.                                                                                                                                              | Too constrained for the existing always-on supervised stack. Do not create traffic to defeat idle rules.                                                               |
| Hetzner CX23, EU      | 2 shared x86 vCPUs, 4 GB RAM, 40 GB disk. Current published server cap €5.49 / US$6.49 monthly; primary IPv4 adds €0.50 / US$0.60. **€5.99 / US$7.09 per month before VAT, backups and other extras.** EU plan page lists 20 TB included traffic; confirm region, overage and checkout terms. | Practical low-cost fallback using the same Compose files. Requires owner approval, account/capacity checks and a separate AMD64 image acceptance run.                  |

Sources: [Oracle resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [Render Free](https://render.com/docs/free), [Koyeb instances](https://www.koyeb.com/docs/reference/instances), [Hetzner June 2026 price table](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [Hetzner IPv4 price](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/), [CX23 specification](https://www.hetzner.com/cloud/cost-optimized/). These are published plan terms, not an account-specific billing guarantee. No exchange conversion to CNY is assumed. Domain/DNS, taxes, backups and overages are separate. Stopping an allocated server does not cancel its bill.

## Zero-paid-API configuration and public-sample restriction

Use `deploy/compose.yml` and `deploy/.env.example` with:

- `APP_ENV=production`, `QLOO_MODE=live`, `RUN_ACCESS=off` and both global provider allowances at zero.
- Empty `qloo_key`, `anthropic_key` and `deepseek_key` files created privately by `deploy/prepare.mjs`.
- Existing production fixture/scripted-generation prohibition, separate child UIDs, root-owned `/run/secrets` mode 0700, TLS database connection and DML-only runtime role.
- Precomputed **synthetic** samples prepared locally with `scripts/seed-judge-demo.ts` are usable in local test/development mode. **Production also rejects fixture reads with 403**, even when a share is featured. Do not import fixtures and claim they form a working public production demo.

Keep the default provider selection unless a separately authorized live evaluation requires DeepSeek. An unconfigured live adapter does not prevent reading otherwise-permitted saved data; it does not override the production fixture ban. It must remain visibly unavailable; do not describe it as authenticated or live-ready.

The newly supported deployment secret `deepseek_key` is read by the root wrapper and delivered only to the worker. For an existing private deployment directory, add a new empty 0600 file under its existing 0700 parent; do not rerun preparation over it or rotate unrelated secrets. Do not copy the user's local private DeepSeek key into any deployment during this task.

Optional DeepSeek activation requires `LLM_PROVIDER=deepseek`, private worker credential, active invitation, fresh pricing/FX verification, explicit live approval and nonzero bounded request/CNY/global limits. Missing or stale settings fail closed. Request and CNY limits are conservative local guards, not a guaranteed provider invoice ceiling. The two earlier trial calls confer no new authorization. No Qloo-derived data transfer is authorized.

## Local verification and sample transfer rehearsal

```sh
# Builds and disposable local smoke only, not a deployment:
docker build --platform linux/arm64 -t tessaloom:submission .
M0_IMAGE=tessaloom:submission node scripts/container-smoke.mjs
REQUIRE_ARM64=1 M10B_IMAGE=tessaloom:submission node deploy/smoke.mjs
```

The full deployment smoke uses isolated networks, fake provider sentinels, internal HTTPS and disposable volumes. It checks direct secret-file denial as the actual child UIDs, worker environment delivery, anonymous invite denial, zero reservations, proxy redaction, database loss/recovery, backup/restore and PID 1 restart. It does not prove cloud firewall, public certificate issuance, internet reachability or external uptime.

To verify prepared samples, export only the `public` schema's data from the fresh synthetic demo database, keeping the dump private. Example for the existing **local development** PostgreSQL container:

```sh
docker exec tessaloom-postgres-1 pg_dump -U tessaloom -d tessaloom_demo --format=custom --data-only --schema=public > /absolute/private/fixture-demo.dump
chmod 600 /absolute/private/fixture-demo.dump
DEPLOY_SECURITY_ONLY=1 DEPLOY_FIXTURE_DUMP=/absolute/private/fixture-demo.dump REQUIRE_ARM64=1 M10B_IMAGE=tessaloom:submission node deploy/smoke.mjs
```

The optional smoke restores into its own disposable database only, checks that all tool invocations are FIXTURE/CACHE, confirms both sample payloads are denied by the production firewall over HTTPS, and verifies attempted browsing creates no runs or spending reservations. The HTML shell can return 200 while its data request correctly returns 403; shell success alone is not a working demo. The import uses a privileged transaction with triggers temporarily disabled to handle circular foreign keys; this is a controlled rehearsal, not an automatic production import mechanism. Never feed it an untrusted dump or point a restore at a user's existing database.

Preserve the production fixture firewall. Keep synthetic demonstrations local or in clearly labelled supporting recordings; public application samples must contain only approved nonfixture content. Before any public sample transfer, obtain the applicable retention/display permission and owner approval. For a future approved transfer, use a new dedicated database/volume and a reviewed import procedure with the worker stopped, provider keys absent and ownership/grants reapplied. Validate referential integrity and sample contents before exposure. Do not import `pg-boss` jobs, workspaces from unrelated projects, real Qloo responses or private live-test evidence. Back up the target first; do not replace a populated database. The synthetic preparation's inaccessible owner workspace is intentional: its samples are locally readable but cannot be edited through it, and remain denied in production.

## Release gates owned by the operator

1. Approve the host, final cost and public deployment. Verify the architecture (ARM64 vs AMD64), entitlement, storage, traffic and recovery access.
2. Build and pin the accepted image digest. Transfer only reviewed files and synthetic sample data; inject fresh private secrets outside the repository.
3. Configure a real hostname, public TLS and cloud/host firewalls. Only HTTPS/HTTP are public; restrict SSH, and keep app/DB ports private. Preserve the proxy trust chain.
4. Verify samples and denial of paid generation from an independent browser, IPv4/IPv6 where configured. Run Chromium and WebKit against the approved public URL before submission.
5. Establish off-host encrypted backups, rehearse restore/reboot, monitor availability and sample expiry through judging. Local successful recovery is not a cloud RTO claim.
6. Confirm the public offering satisfies current event rules. A read-only fixture sample is useful and honest but does not prove live Qloo application E2E.

No public exposure, invitation issuance, billing activation, DNS change or cloud resource operation is performed by this document.
