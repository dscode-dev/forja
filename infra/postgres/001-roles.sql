\set ECHO none
\set VERBOSITY terse
-- Local-only role/schema bootstrap. No user/financial data and no encryption keys.
-- Read mounted secrets inside PostgreSQL, never echo them in process arguments.
SELECT format('CREATE ROLE forja_app LOGIN PASSWORD %L', rtrim(pg_read_file('/run/forja-init-secrets/api-password'), E'\n')) \gexec
SELECT format('CREATE ROLE forja_migrator LOGIN PASSWORD %L', rtrim(pg_read_file('/run/forja-init-secrets/migration-password'), E'\n')) \gexec
REVOKE ALL ON DATABASE forja FROM PUBLIC;
GRANT CONNECT ON DATABASE forja TO forja_app, forja_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA app AUTHORIZATION forja_migrator;
GRANT USAGE ON SCHEMA app TO forja_app;
CREATE DATABASE forja_test;
REVOKE ALL ON DATABASE forja_test FROM PUBLIC;
GRANT CONNECT ON DATABASE forja_test TO forja_app, forja_migrator;
\connect forja_test
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA app AUTHORIZATION forja_migrator;
GRANT USAGE ON SCHEMA app TO forja_app;
