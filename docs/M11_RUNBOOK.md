# M11 deployment and rollback runbook

> Deployment decision updated 2026-10-25: Northflank is selected. Use [the Northflank recovery runbook](NORTHFLANK_RUNBOOK.md); hosting comparisons below are historical, and Compose commands apply to local tests only.

This is an operator procedure, **not permission to deploy**. M11 executes only disposable local tests. Hosting purchase/provisioning, public exposure, live provider use, source publication and submission remain separate owner decisions. [Hosting decision](M11_HOSTING.md), [judge access](M11_JUDGE_ACCESS.md), [acceptance](M11_ACCEPTANCE.md).

## 1. Freeze an accepted release

Use `codex/m11-public-demo`, based on main `492a6526709b806122dc52b0c9e4141c19f97688` (PR #14). Record the actual M11 checkpoint with `git rev-parse HEAD`. No application/schema/dependency changes are intended in M11. Keep the previous image and release directory for rollback.

Normal full build, on a trusted builder with Node/package/font-host connectivity, followed by local acceptance:

```sh
docker build --platform linux/arm64 -t tessaloom:m11 .
REQUIRE_ARM64=1 M10B_IMAGE=tessaloom:m11 node deploy/smoke.mjs
M0_IMAGE=tessaloom:m11 node scripts/container-smoke.mjs
docker image inspect tessaloom:m11 --format '{{.Id}} {{.Os}}/{{.Architecture}}'
```

For CX23 use `linux/amd64`, a separate tag and omit `REQUIRE_ARM64`. An ARM image cannot be substituted for AMD64 acceptance. Builds need more memory than the running service; do not build on the constrained 4-GB VPS. Google fonts are downloaded during build then self-hosted; no browser font-host access is required in production. The M11 clean build initially stalled on those downloads; see the verification report for the image actually tested.

For this deployment-entrypoint-only change, an explicitly accepted existing runtime may instead be reused without recompiling the unchanged app:

```sh
# Inspect and compare against the accepted base ID before using its local tag.
docker image inspect tessaloom:submission --format '{{.Id}}'
# Expected base: sha256:d806ce325865ffe673f83aefd12dcfc1c4799f3f63ed8052c22f984a08dbf801
docker build -f deploy/Dockerfile.runtime \
  --build-arg VERIFIED_BASE_IMAGE=tessaloom:submission -t tessaloom:m11 .
```

This path changes only `/app/deploy/app-entrypoint.mjs`; it must not be used if web/worker/DB bundles, migrations, supervisor, dependencies or Docker runtime requirements change. Keep the base image ID, new ID and source checkpoint together. A local image is not a public image registry release.

Export the accepted image privately; no registry publication is necessary:

```sh
docker save -o /absolute/private/tessaloom-m11.tar tessaloom:m11
shasum -a 256 /absolute/private/tessaloom-m11.tar
git archive --format=tar --output=/absolute/private/tessaloom-m11-source.tar HEAD
```

Use an existing private directory, mode 0700, with `umask 077`. Transfer by authenticated SSH/SCP only after host approval. Compare archive checksum on the host (`sha256sum`), then `docker load -i /absolute/private/tessaloom-m11.tar`. Extract the source archive into a **new** release directory, e.g. `/opt/tessaloom/releases/M11_CHECKPOINT`. Never copy `.env`, provider credentials, local fixtures or working-tree dumps as deployment data. Pin `APP_IMAGE` to the inspected local image ID after load, or an approved immutable registry digest. Keep the archive for recovery.

## 2. Host/account preparation — after the owner's approval

1. Choose Oracle only after account approval and console verification of free entitlement/capacity; otherwise review the exact Hetzner quote (base $7.09/month before tax/extras). Select a supported Linux image, e.g. Ubuntu 24.04 LTS, matching ARM64/A1 or AMD64/CX23. Keep boot disk deletion on VM deletion disabled where offered; record the actual persistence behavior. No paid trial upgrade, paid add-ons or account-wide changes are part of this procedure.
2. Create a key-only operator account and validate a second SSH session. Set time synchronization, security updates and recovery-console access. Restrict cloud firewall SSH to the owner's current CIDR. Keep inbound 80/443 closed until public approval. Block 3000/5432/2019 on both address families; publish neither app nor DB ports. Docker administrators are trusted root-equivalent operators.
3. Install Docker Engine and the Compose plugin using the [official OS procedure](https://docs.docker.com/engine/install/ubuntu/); verify `docker version`, `docker compose version` and `uname -m`. Enable Docker at boot. UFW alone cannot enforce Docker-published port policy: verify cloud rules and Docker forwarding rules. Do not disable the firewall or expose the Docker API. Use at least 4 GB RAM and reserve space for data, seven dumps and two images.
4. Choose an existing controlled domain or a free [DuckDNS subdomain](https://www.duckdns.org/about.jsp), subject to account/hostname availability. Protect DNS tokens outside the app. After DNS approval, set an A record to the VM; add AAAA only when IPv6 is configured and tested. Use DNS-only routing for the direct Caddy design; enabling a CDN changes the proxy trust chain and needs another review.
5. Prepare an existing owner-controlled encrypted off-host backup destination, sufficient free space, retention and a recovery key stored separately. No automatic cloud backup subscription is assumed.

## 3. Private configuration and local-only startup

On the approved host, from the release directory, with Node 22.19+ and OpenSSL available:

```sh
umask 077
mkdir -p /opt/tessaloom/private /opt/tessaloom/backups
chmod 700 /opt/tessaloom/private /opt/tessaloom/backups
# NEW directory only; never rerun this over existing credentials.
node deploy/prepare.mjs /opt/tessaloom/private/m11
cp deploy/.env.example /opt/tessaloom/private/deploy.env
chmod 600 /opt/tessaloom/private/deploy.env
```

Edit `deploy.env` privately: accepted `APP_IMAGE`, `PRIVATE_DIR=/opt/tessaloom/private/m11`, reviewed `TLS_DOMAIN`, real owner `ACME_EMAIL`. Keep `BIND_IP=127.0.0.1`, `HTTP_PORT=8080`, `HTTPS_PORT=8443`, `RUN_ACCESS=off`, both global budgets zero, DeepSeek approval off and its request/CNY limits zero. Leave all three provider-key files empty. The env file contains configuration, not provider keys. Retain the DB CA signing key offline; no application container mounts it.

Use a fresh operator shell: **unset previously exported variables named in the env file**, since shell variables override Compose `--env-file`. Do not source the application's development `.env`. Never print populated container environments or enable shell tracing. Explicitly use the same project name for every operation so the existing volumes are reused:

```sh
TL_ENV=/opt/tessaloom/private/deploy.env
TL_PROJECT=tessaloom-demo
dc() { docker compose --env-file "$TL_ENV" --project-name "$TL_PROJECT" -f deploy/compose.yml "$@"; }
dc config --quiet
dc up -d --wait --wait-timeout 120 postgres
dc run --rm migrate
# A second run must be a no-op, not a destructive reset.
dc run --rm migrate
dc up -d --wait --wait-timeout 120 app
dc run --rm admin spend today
dc exec -T app node -e 'fetch("http://127.0.0.1:3000/api/health/ready").then(async r=>{const b=await r.json();console.log({status:r.status,db:b.db,worker:b.worker});process.exit(r.ok&&b.db&&b.worker?0:1)})'
```

Do not start direct Caddy yet: its automatic certificate manager can contact ACME even if host ports are loopback-only. App/DB have no published ports. The new administrator profile does not run during ordinary `up`; it has no provider/session secrets or outbound network. An application health result proves DB/worker heartbeat, **not provider authentication or meaningful sample availability**.

## 4. Public HTTPS cutover — explicit approval required

After host, DNS, firewall, sample and judge-access review, change `deploy.env` to `BIND_IP=0.0.0.0`, `HTTP_PORT=80`, `HTTPS_PORT=443`. Open cloud TCP 80/443 to the internet. This config publishes IPv4; add IPv6 DNS only after a separately verified IPv6 listener/firewall configuration. Caddy uses its persistent data volume for public certificates and renewal state. Keep access logs off and the filtered error logger intact.

```sh
dc up -d --wait --wait-timeout 120 app proxy
dc ps
# Run from an independent internet connection; replace the example with the approved hostname.
node deploy/health.mjs https://YOUR_REVIEWED_HOSTNAME
curl --fail --max-time 15 -I http://YOUR_REVIEWED_HOSTNAME
curl --fail --max-time 15 -I https://YOUR_REVIEWED_HOSTNAME/
```

The probe verifies a trusted certificate and checks `/api/health` and `/api/health/ready`, no-store, HSTS and the DB/worker booleans. It makes no Qloo readiness/authentication request, follows no redirect, prints no body/URL/credentials, and fails nonzero after bounded waits. `--ca` is solely for private-CA rehearsal; use the system public trust store in hosted acceptance. Never use `curl -k` or disable TLS verification to make acceptance pass.

Verify HTTP redirects to the same HTTPS hostname, certificate hostname/chain, no mixed content, security headers, Secure/HttpOnly/SameSite cookies and cross-origin mutation rejection. From another network inspect that only approved 22/80/443 are reachable and app/DB/admin ports are closed. Test IPv4 and any configured IPv6, including direct IP access. Keep the one-hop Caddy forwarding policy; forged XFF/Forwarded/X-Real-IP cannot create a new limiter identity.

In private Chromium and WebKit windows, test the real sample data, graph, What-if comparison, blueprint/export and share revocation. Confirm anonymous generation is denied and creates neither runs nor reservations. Separately approved live tests must verify SSE progress, reconnection, cancellation and final outcomes with real Qloo provenance. Do not run a generation test while zero-call restrictions remain in effect.

## 5. Backups, recovery and daily checks

Create private, unique backups before releases and at least daily. The helper accepts an explicit env file/project and refuses overwrite; it retains `.partial` on failure. Do not run it during migrations. It dumps only the application database; provisioned roles/passwords, TLS keys and session/pepper files need a separate encrypted backup.

```sh
TL_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TL_RESTORE_STAMP=$(date -u +%Y%m%d%H%M%S)
TL_DUMP="/opt/tessaloom/backups/tessaloom-$TL_STAMP.dump"
bash deploy/backup.sh "$TL_DUMP" "$TL_ENV" "$TL_PROJECT"
# Restore into a NEW scratch database on this stack; never overwrite tessaloom.
bash deploy/restore-check.sh "$TL_DUMP" "$TL_ENV" "$TL_PROJECT" "tl_restore_$TL_RESTORE_STAMP"
```

The scratch name accepts lowercase letters/numbers/underscores only; the commands use a separate numeric timestamp, e.g. `tl_restore_20261024110000`. The helper intentionally refuses an existing target; preserve its failed scratch DB for diagnosis and choose a new name after correction. Only restore a trusted dump: database dumps can execute SQL. It does not start a worker, replace the primary DB or delete anything.

Compare migration count (currently eight), project counts, grants/revocations, reservation counts/status/cost totals and expected saved data against the source record. Restore uses the migrator role, preserves grants/default privileges and verifies runtime reads; runtime must still be unable to run DDL. Run source/target count queries privately, never publish DB content. A local dump is not disaster recovery.

For example, with an existing reviewed `age` installation and owner recovery recipient:

```sh
# Set TL_AGE_RECIPIENT to the owner's verified public encryption recipient first.
test ! -e "$TL_DUMP.age"
age -r "$TL_AGE_RECIPIENT" -o "$TL_DUMP.age" "$TL_DUMP"
sha256sum "$TL_DUMP.age"
# Copy the encrypted file using the owner's approved SCP destination, then verify checksum there.
```

Verify decryption and scratch restore from the **downloaded off-host copy** before considering this operational. Keep seven successful daily copies plus the pre-release backup, bounded by disk space. Remove older copies only according to the approved retention policy; never delete the last good backup before its replacement is verified. Do not print a decryption identity or copy it beside the ciphertext. Target RPO <=24 hours only after daily off-host success; cloud RTO must be measured.

Prepare a daily host timer for backup/encryption/off-host copy and a five-minute readiness probe from an independent owner-controlled machine. No schedules, uploads or messages are installed by M11. Record failures, stale backups (>26 hours), DB certificate expiry (<30 days), public certificate expiry (<14 days), low disk (<20% free), OOM/restart counts and readiness loss. Agree an owner alert destination and test delivery after approval. Docker restarts exited processes; it does not auto-heal every unhealthy container. Do not install a Docker-socket auto-healer. Test a real approved-host reboot while preserving volumes and measure recovery.

## 6. Release, graceful shutdown and rollback

For any later release: record source/image IDs and current migration journal, prepare a verified backup and off-host copy, and enter a maintenance window. Set `RUN_ACCESS=off` before starting new maintenance work; existing already-dispatched calls may finish. Stop the app to prevent further worker execution. Do not assume changing an env file updates a running container.

```sh
dc stop app
bash deploy/backup.sh /opt/tessaloom/backups/UNIQUE_PRE_RELEASE.dump "$TL_ENV" "$TL_PROJECT"
# Edit APP_IMAGE to the accepted next image ID in TL_ENV.
dc run --rm migrate
# Only after migration succeeds:
dc up -d --wait --wait-timeout 120 app proxy
```

Failure leaves the app stopped; do not ignore a failed migration. If schemas are unchanged/backward-compatible (as for M11), restore the previous release directory and image ID in the same env/project, keep all budgets off/zero and run `dc up -d --wait app proxy`, then the HTTPS probe and saved-data acceptance. Do not switch the Compose project name: that would select different volumes. Preserve the accepted previous Caddy config and its persistent certificate volume. Rollback does not roll back spending or delete newer user data.

If a schema/data restore is required, do not run down-migrations or restore over the only production database. Create an isolated recovery project with **new volumes**, original compatible secrets/pepper, zero budgets and provider files absent/empty; start only PostgreSQL. Use `restore-check.sh` into a fresh `tl_restore_...` database and compare the data/ledger. Keep the original stack stopped and preserved. On the recovery stack only, after validation and confirming no app connections, rename its new empty `tessaloom` database to an unused holding name, promote the scratch database, and restore the bootstrap marker/CONNECT policy:

```sql
-- Connect to postgres, not the database being renamed. Names are reviewed literals.
ALTER DATABASE tessaloom RENAME TO tl_empty_hold;
ALTER DATABASE tl_restore_20261024110000 RENAME TO tessaloom;
REVOKE ALL ON DATABASE tessaloom FROM PUBLIC;
GRANT CONNECT ON DATABASE tessaloom TO tessaloom_app;
COMMENT ON DATABASE tessaloom IS 'tessaloom-bootstrap-v1-complete';
```

Review restored queue/run state and reconcile provider invoices, grants and unknown reservations **before starting a worker**. Backup-era spend can be older than actual charges. Do not mark unknown charges free, resume stale jobs blindly or enable keys to test recovery. Reapply migrations only after confirming image compatibility. Validate runtime DB TLS/DML and private saved-data views, then separately approve route/DNS cutover. Preserve the original volume and the holding DB until the recovery is accepted. This promotion is a documented operator procedure; M11's automated test proves scratch restore, not a cloud disaster cutover.

For emergency public withdrawal, `dc stop proxy` removes the ingress but leaves work running; `dc stop app proxy` also stops workers. For a planned complete shutdown use `dc stop app proxy` then `dc stop postgres`; grace periods are 35/60 seconds. Use `start` or `up` to resume deliberately stopped services; `unless-stopped` will not undo an intentional stop after reboot. Never use `down --volumes`, global prune, destroy the VM/disk or release an IP as a routine rollback.
