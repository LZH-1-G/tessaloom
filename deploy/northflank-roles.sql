-- NEW / EMPTY application database only, after backup + read-only diagnosis.
-- Run with the existing Northflank addon's administrator inside a private psql session.
-- Set TL_MIGRATOR_PASSWORD and TL_APP_PASSWORD through a restricted secret environment;
-- never psql -v password=..., never paste passwords into commands/history.
-- Deliberately fails if these roles already exist. Inspect/reuse them, do not drop them.
\set ON_ERROR_STOP on
\getenv migrator_password TL_MIGRATOR_PASSWORD
\getenv app_password TL_APP_PASSWORD
BEGIN;
-- No ownership reassignment of existing data. Abort instead of modifying an unknown schema.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public', 'pgboss', 'drizzle')) THEN
    RAISE EXCEPTION 'Existing schema: review migration owner before bootstrap';
  END IF;
END $$;
CREATE ROLE tessaloom_migrator LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE tessaloom_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SELECT current_database() AS database_name \gset
REVOKE CREATE ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE :"database_name" TO tessaloom_migrator;
GRANT CONNECT ON DATABASE :"database_name" TO tessaloom_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO tessaloom_migrator;
CREATE SCHEMA pgboss AUTHORIZATION tessaloom_migrator;
GRANT USAGE ON SCHEMA public, pgboss TO tessaloom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tessaloom_migrator IN SCHEMA public, pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tessaloom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tessaloom_migrator IN SCHEMA public, pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO tessaloom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tessaloom_migrator IN SCHEMA pgboss
  GRANT EXECUTE ON FUNCTIONS TO tessaloom_app;
COMMIT;
