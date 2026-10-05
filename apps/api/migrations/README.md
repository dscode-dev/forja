# Migrations

Explicit node-pg-migrate migrations own every application schema change. app.schema_migrations is tooling bookkeeping; app.user_data_keys stores only authenticated wraps and approved metadata. No identity/financial schema or runtime seeds exist.

Use scripts/dev migrate under the migrator role. Replay is safe; API startup never migrates. The wrapped-key migration refuses destructive down execution. Review forward repair, locks, retention and backup/key dependencies before schema evolution; never delete wraps as a rollback convenience. Canonical contracts: [persistence](../../../docs/persistence.md), [security](../../../docs/security.md).
