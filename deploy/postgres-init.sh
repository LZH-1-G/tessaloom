#!/usr/bin/env bash
set -euo pipefail
# psql reads passwords from environment, never command-line arguments or output.
export TL_APP_PASSWORD="$(cat /run/postgresql/tls/app_password)"
export TL_MIGRATOR_PASSWORD="$(cat /run/postgresql/tls/migrator_password)"
psql -v ON_ERROR_STOP=1 --username postgres --dbname tessaloom <<'SQL'
\getenv app_password TL_APP_PASSWORD
\getenv migrator_password TL_MIGRATOR_PASSWORD
CREATE ROLE tessaloom_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE tessaloom_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
REVOKE ALL ON DATABASE tessaloom FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE tessaloom TO tessaloom_migrator;
GRANT CONNECT ON DATABASE tessaloom TO tessaloom_app;
ALTER SCHEMA public OWNER TO tessaloom_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA pgboss AUTHORIZATION tessaloom_migrator;
GRANT USAGE ON SCHEMA public, pgboss TO tessaloom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tessaloom_migrator IN SCHEMA public, pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tessaloom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tessaloom_migrator IN SCHEMA public, pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO tessaloom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tessaloom_migrator IN SCHEMA pgboss
  GRANT EXECUTE ON FUNCTIONS TO tessaloom_app;
COMMENT ON DATABASE tessaloom IS 'tessaloom-bootstrap-v1-complete';
SQL
unset TL_APP_PASSWORD TL_MIGRATOR_PASSWORD
