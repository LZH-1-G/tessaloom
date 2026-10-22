#!/usr/bin/env bash
set -euo pipefail
# The official entrypoint drops to postgres after this root-only certificate copy.
install -d -m 0700 -o postgres -g postgres /run/postgresql/tls
install -m 0600 -o postgres -g postgres /run/secrets/db_key /run/postgresql/tls/server.key
install -m 0644 -o postgres -g postgres /etc/tessaloom/db.crt /run/postgresql/tls/server.crt
for name in app_password migrator_password; do
  install -m 0600 -o postgres -g postgres "/run/secrets/$name" "/run/postgresql/tls/$name"
done
install -m 0644 /etc/tessaloom/postgres-init.sh /docker-entrypoint-initdb.d/10-tessaloom.sh
exec /usr/local/bin/docker-entrypoint.sh postgres \
  -c ssl=on -c ssl_min_protocol_version=TLSv1.2 \
  -c ssl_cert_file=/run/postgresql/tls/server.crt \
  -c ssl_key_file=/run/postgresql/tls/server.key \
  -c hba_file=/etc/tessaloom/pg_hba.conf \
  -c shared_buffers=128MB -c work_mem=4MB -c max_connections=40 \
  -c password_encryption=scram-sha-256
