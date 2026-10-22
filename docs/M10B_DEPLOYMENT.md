# M10-B: zero-cost deployment preparation

Status: locally verifiable deployment preparation complete; see [M10B_VERIFICATION.md](M10B_VERIFICATION.md) for completed checks and remaining acceptance gates; **no cloud resources provisioned, no public deployment, no live provider calls**. Baseline: PR #12 merge `96d48c1`, branch `codex/m10b-deployment`. The branch initially pointed to M9; the owner explicitly authorized fetching `origin/main` and a fast-forward before implementation. No push or merge commit was made by this task.

## Feasibility and current hosting comparison

A single Linux ARM64 VM can host the existing supervised web/worker container, Caddy, and PostgreSQL. The earlier M10-A image and local Docker host are ARM64. M10-B verifies the new configuration separately; consult the verification record below before treating it as tested. This is a small-demo topology with a single point of failure, not high availability. Hosting at $0 is technically plausible, conditional on account eligibility, available capacity, storage/traffic allowances, and reliable off-host backups. Provider API spending is a separate budget.

Official sources checked on 2026-10-22:

| Candidate | Current published basis | Account-specific decision |
|---|---|---|
| Oracle Always Free A1 | Free Tier documentation currently states 1,500 OCPU-hours and 9,000 GB-hours/month, equivalent to **2 OCPUs / 12 GB**, with 200 GB combined boot/block storage and five volume backups. | Use the lower documented allocation until the console and billing entitlement confirm otherwise; subtract existing resources. A service quota alone is not proof of free billing. |
| Hetzner CX23, EU | June 2026 price table: **€5.49 / US$6.49 monthly**, excluding IPv4 and VAT. Primary IPv4 adds **€0.50 / US$0.60**, giving **€5.99 / US$7.09** before tax/extras. | 2 x86 vCPUs, 4 GB RAM, 40 GB disk. Confirm availability, currency, tax, backups, traffic and checkout total before purchase. Requires a separate AMD64 image verification. |

Sources: [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [Hetzner June 2026 prices](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [Hetzner primary IP prices](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/), [CX23 specification/availability](https://www.hetzner.com/cloud/cost-optimized/).

Oracle's [price list](https://www.oracle.com/cloud/price-list/) still advertises 3,000 OCPU-hours / 18,000 GB-hours for A1. This conflicts with the Free Tier documentation; do not assume an account upgrade is needed or authorize one to resolve it. Confirm the actual tenancy entitlement with Oracle first. The [Free Tier guide](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm) restricts free compute to the home region and warns about excess A1 resources at trial expiry. Trial credits are not recurring free hosting.

Oracle can reclaim idle instances based on seven-day utilization criteria. Capacity shortages and reclamation make uninterrupted demo availability uncertain. Do not manufacture CPU/network load to evade idle rules. Always Free object storage is limited (20 GB combined after a free trial, with API request limits); verify remaining allowance and expiry behavior before choosing it for backups. A small encrypted backup copied to an existing owner-controlled computer can avoid buying storage but needs a reliable schedule and restore drill. See the Oracle resource source above.

Hetzner bills allocated servers until deletion; stopping a server does not end its bill. Snapshot/backup storage, extra volumes, traffic overage, additional IPs and taxes are separate risks. No plan is ordered by these files. The quoted total is not a guaranteed invoice or exchange-rate conversion.

## Topology and isolation

```text
Internet -> cloud firewall -> host TCP 80/443 -> Caddy -> app:3000
                                                         |
                                           one supervisor (root)
                                            /                 \
                                  web UID 10001       worker UID 10002
                                            \                 /
                                       PostgreSQL:5432 over verified TLS
```

`deploy/compose.yml` is separate from the existing development Compose file. Only Caddy publishes ports. Defaults bind to **127.0.0.1:8080/8443**; changing to public 80/443 requires explicit deployment approval. App and database have no published port. The backend network is internal; app and proxy also have an outbound network for future approved provider/ACME access. The smoke test makes both networks internal and sends HTTPS from a disposable internal client. It verifies the loopback-only port configuration structurally; actual host/cloud port reachability remains a hosted acceptance check.

Caddy overwrites X-Forwarded-For with the actual peer address and removes alternate address assertions. `TRUSTED_PROXY_HOPS=1` is valid only for this direct-client -> Caddy topology. Preserve Host for CSRF and stream SSE without buffering. Do not add a CDN or another proxy without reassessing the trust chain. Do not enable Docker direct routing or unprotected bridge mode. Cloud security rules and host forwarding rules must block direct app/DB access on IPv4 and IPv6; relying on UFW alone is insufficient because Docker-published ports can bypass it. Sources: [Caddy proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [Docker firewall behavior](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

Only TCP 80/443 should be public. SSH 22 is restricted to the operator's source CIDR, key-only authentication, no root login. Validate a second SSH session before changing firewall rules. Leave PostgreSQL 5432, app 3000 and Caddy administration unexposed. Caddy administration is disabled. HTTP/3 UDP 443 is not published. Host patching, Docker daemon security, time synchronization, disk encryption and SSH access remain operator responsibilities. Docker administrators can access secrets; Compose secrets are local file mounts, not an encrypted cloud vault.

## Resource envelope

| Component | Container memory cap | Details |
|---|---:|---|
| App, including both children | 2,048 MiB | Web old-space 512 MiB; worker 768 MiB; 768 MiB remaining for native allocations, supervisor, harness and other memory. Heap size is not RSS. |
| PostgreSQL | 768 MiB | 128 MiB shared buffers, 4 MiB work_mem, 40 connections; work_mem can multiply by queries/operators. |
| Caddy | 128 MiB | Small demo target; test actual concurrency and TLS load. |
| One-shot migrator | 384 MiB | Run before app startup/release; heap 256 MiB. |

Steady container caps total 2,944 MiB; reserve at least another 1 GiB for the OS, Docker and filesystem/cache. A 4 GB CX23 is a constrained candidate, while a verified 12 GB A1 allowance has headroom. Actual memory under live model/harness workloads is unverified. `mem_limit` and equal `memswap_limit` enforce memory caps without container swap. PID limits and log rotation also apply. Global active runs are reduced to two, without weakening per-run spending controls. Start with small traffic and monitor OOM events, disk space, queue latency and connection counts.

On a 4 GB fallback, drain/stop the app after a backup before release migrations, then restart after success; budget this maintenance downtime rather than exhausting OS headroom.

Build images locally or on approved CI before transfer. Image builds can need significantly more RAM and disk than the running service; do not assume a 4 GB host can build reliably. Native ARM64 local build/run verification does not measure Ampere CPU performance or prove x86 compatibility. Pin approved image digests at release, record them with the commit, and remove unused images only after confirming rollback requirements.

## Safe local preparation

Requirements: Node 22.19+, OpenSSL, Docker Engine with Compose v2, and enough free local disk/RAM. No credentials from `.env` are loaded by these helpers.

```sh
# New directory only. Refuses to overwrite or rotate existing material.
node deploy/prepare.mjs /absolute/private/tessaloom

docker build --platform linux/arm64 -t tessaloom:m10b .
REQUIRE_ARM64=1 M10B_IMAGE=tessaloom:m10b node deploy/smoke.mjs
```

Preparation creates random local database/session secrets, a private database CA, a 90-day server certificate valid for Docker hostname `postgres`, and **empty provider-key files**. Keep the directory mode 0700, private keys/password files 0600; public certificates are 0644. Store private material outside the repository. The CA signing key need not be mounted into any container and should be stored offline. Renew the DB certificate before day 90; retain the existing CA or perform a planned trust rotation. Never rerun preparation over a production directory. Session/pepper rotation can invalidate sessions and share/access-code hashes.

The app wrapper requires root and secures the container-local `/run/secrets` parent as root-owned mode 0700 before loading files or starting children. This closes a verified file-mount permission bypass: relying on host file modes alone allowed a child UID to read mounted secrets on the tested Compose runtime. Both web and worker are denied direct file reads; the supervisor passes provider values only into the worker environment, so the worker retains the access it needs. Public database CA certificates live outside this protected directory. Do not mount the entire `/run/secrets` parent from the host or replace this wrapper with a shell that skips the protection.

The app wrapper constructs a database URL using `sslmode=verify-full` and the mounted private CA. It passes app credentials to the existing allowlisted supervisor; it never loads the migrator password in the runtime service. PostgreSQL rejects non-TLS TCP connections and only admits app/migrator roles to the application database. The migrator owns schemas; runtime is DML-only. Bootstrap runs **only on an empty PostgreSQL volume**; changing files later does not rotate database passwords or reapply grants. Existing volumes require a reviewed migration/rotation procedure.

Production retains the fixture firewall. `QLOO_MODE=live` and `LLM_PROVIDER=anthropic` describe the production adapters but do not authorize calls: the prepared files have no provider credentials, `RUN_ACCESS=off`, and both global provider allowances are zero. The underlying application defaults to invite access in production; the deployment wrapper permits only `off` or `invite`, never `open`. Grant activation, budgets, keys and live calls require separate approval. Keep provider account hard limits as an independent control. Never restore a database and enable paid work before reconciling its spending ledger.

## Manual setup, only after approval

1. Confirm the Oracle home region, Always Free eligibility, actual A1 capacity, aggregate free usage, boot/block performance tier, public IP/egress treatment, object/API limits and post-trial billing. Screenshot cost estimates privately. Do not upgrade to PAYG, provision paid shapes, add NAT gateways/load balancers, or accept chargeable defaults. Budget alerts are notifications, not hard spending caps. If capacity is unavailable, ask before using Hetzner.
2. Create the approved VM and persistent storage, install supported OS/Docker, secure SSH/firewalls and establish recovery access. Record whether volume deletion is coupled to VM deletion. A single named volume is persistence across containers, not protection from losing the VM/disk/account.
3. Register a free hostname such as an available DuckDNS subdomain, configure its A record (and AAAA only if IPv6 works), protect the DNS account/token, and confirm propagation. [DuckDNS](https://www.duckdns.org/about.jsp) offers free subdomains; availability and continuity are third-party dependencies. No domain was registered here. Keep DNS update tokens outside the app.
4. Transfer the verified image and deploy files without secrets in the build context. Use an immutable image digest in APP_IMAGE. Copy private configuration through an approved secure channel. Inspect Compose configuration without dumping populated secret environments into logs.
5. Use `deploy/.env.example` as a non-secret template for APP_IMAGE, PRIVATE_DIR, TLS_DOMAIN and ACME_EMAIL. Export them in the operator environment, or pass `--env-file /absolute/private/deploy.env` to each Compose command (the backup helper requires exported values). Do not assume Compose automatically reads `deploy/.env`. First keep BIND_IP=127.0.0.1. Start only postgres, then run the release service, then start app/proxy. Commands below operate infrastructure and must not be run against a real server before approval.

```sh
docker compose -f deploy/compose.yml up -d --wait postgres
docker compose -f deploy/compose.yml run --rm migrate
docker compose -f deploy/compose.yml up -d --wait app proxy
```

6. After public deployment approval, use BIND_IP=0.0.0.0, HTTP_PORT=80 and HTTPS_PORT=443 and verify firewall rules externally. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) obtains/renews certificates and redirects HTTP when DNS and ports are correct. Certificate issuance and renewal have rate limits and external availability dependencies. Persist `/data` to avoid unnecessary reissuance. Only the local smoke uses internal TLS; browsers must trust a public certificate on the real site.
7. Verify redirect, certificate chain/hostname, HSTS, Secure cookies, CSRF, private data isolation, read-only samples, anonymous denial, forged forwarding headers and inability to reach ports 3000/5432 externally. Repeat from IPv4 and IPv6 as applicable. The local smoke does not prove cloud firewall behavior.
8. Configure backups and notifications, rehearse restore and VM reboot, and record measured RPO/RTO and memory load before sharing the URL. Enable invite-only live work only through a separately approved credential/budget change and live acceptance test.

## Backup, health and recovery

`bash deploy/backup.sh /absolute/private/backups/NEW.dump` uses custom-format pg_dump over the container-local Unix socket. It refuses an existing destination, writes a private `.partial` file, and renames only after success. It uses the same Compose environment/project as the deployment. Do not run it during schema migration. Dumps contain private project/session information: encrypt before copying off-host, restrict retention and access, and never commit them. Schedule daily backups with an operator-owned timer, plus a pre-release backup; monitor failure and stale timestamps. Seven retained daily copies are an initial policy, bounded by actual storage. No timer or external upload is installed by this task.

A dump on the same VM is not disaster recovery. Confirm a free, encrypted off-host destination, available space and download access. Local PostgreSQL plus daily dumps provides no managed PITR: the previous managed-database/PITR recommendation is superseded for this $0 option, with explicit owner acceptance of the recovery tradeoff before launch. Target RPO up to 24 hours only if daily off-host backups succeed; RTO remains unmeasured in the cloud.

Restore to a **new** database/volume with the worker stopped and provider keys absent, using pg_restore --exit-on-error --no-owner; reapply role ownership/grants before restarting runtime. Verify journal, project counts, saved views, grants and ledger. Do not replay restored jobs or erase unknown reservations to recover budget. Preserve the original volume. The local smoke restores a scratch database and checks data/journal; it does not authorize an in-place recovery.

Docker `restart: unless-stopped` restarts exited services and starts them after daemon/host restart unless deliberately stopped. It does **not** restart a merely unhealthy container. The supervisor handles child crashes/backoff and exits on repeated crashes. Readiness detects DB/worker failures; liveness remains separate. Operators must investigate stuck/unhealthy processes and alert on prolonged readiness failure; do not install a privileged Docker-socket auto-healer. A database restart should recover without deleting volumes. Grace periods allow supervisor and PostgreSQL shutdown. Avoid `compose down --volumes` on real data; the smoke uses it only for its uniquely named disposable stack.

Use an existing free monitoring mechanism or operator timer to check readiness, certificate expiry, backup age, disk free space, OOM/restarts and spending alarms, then send alerts only to an explicitly configured owner destination. No messages/alerts have been sent or external monitor registered. Caddy access logs are disabled, and its error-log encoder removes request URIs and headers to protect share tokens and credentials. Docker rotates JSON application/DB logs; application child logs keep M10-A redaction and UID separation. OS-level/root access remains trusted.

## Verification record

See [M10B_VERIFICATION.md](M10B_VERIFICATION.md) for exact results, the mounted-secret defect and fix, image identity, and unrun cloud checks. To resume only the two deployment security checks without repeating backup/recovery and the cross-module suites:

```sh
DEPLOY_SECURITY_ONLY=1 REQUIRE_ARM64=1 M10B_IMAGE=tessaloom:m10b node deploy/smoke.mjs
```

The test prepares fresh private material, substitutes deliberately invalid provider sentinels, isolates both networks, and inspects credentials without printing values. No hosted check, live billing check, external CI run, infrastructure purchase or public deployment is implied by local tests.
