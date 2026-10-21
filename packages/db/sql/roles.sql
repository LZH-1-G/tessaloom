-- Least-privilege database roles (DATABASE_SCHEMA.md §8). Run once per environment by an
-- administrator, after replacing the placeholder passwords via the provider's secret tooling.
-- Never commit real passwords. Managed providers may require creating roles in their console.

-- Owns the schema; used only by the release/pre-deploy migration step.
CREATE ROLE tessaloom_migrator LOGIN PASSWORD :'migrator_password';
-- Used by the web and worker processes.
CREATE ROLE tessaloom_app LOGIN PASSWORD :'app_password';

-- Run with: psql -v database_name=<db> -v migrator_password=… -v app_password=… -f roles.sql
GRANT CONNECT ON DATABASE :"database_name" TO tessaloom_app;
GRANT USAGE ON SCHEMA public TO tessaloom_app;

-- Data access without DDL or TRUNCATE. Append-only tables are additionally protected by
-- BEFORE UPDATE triggers (migration 0001), so even this role cannot rewrite them.
ALTER DEFAULT PRIVILEGES FOR ROLE tessaloom_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tessaloom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tessaloom_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tessaloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tessaloom_app;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM tessaloom_app;
