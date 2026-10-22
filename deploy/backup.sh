#!/usr/bin/env bash
# Requires the reviewed Compose environment (APP_IMAGE, PRIVATE_DIR, TLS_DOMAIN, ACME_EMAIL).
set -euo pipefail
umask 077
out=${1:?Provide a NEW backup pathname outside the repository}
[[ $out = /* && ! -e $out && ! -e $out.partial ]] || { echo 'Backup requires a new absolute pathname' >&2; exit 1; }
# noclobber prevents overwriting a racing file; .partial is retained on failure for diagnosis.
set -o noclobber
docker compose -f "$(dirname "$0")/compose.yml" exec -T postgres \
  pg_dump -U postgres -d tessaloom --format=custom --lock-wait-timeout=30s > "$out.partial"
ln "$out.partial" "$out"
rm "$out.partial"
echo 'Backup completed. Encrypt and copy off-host; a local dump alone is not disaster recovery.'
