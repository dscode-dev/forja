exports.up = pgm => pgm.sql(`
CREATE TABLE app.user_data_keys (
 user_id uuid NOT NULL, dek_id uuid PRIMARY KEY, dek_version integer NOT NULL CHECK (dek_version > 0),
 wrap_format smallint NOT NULL CHECK (wrap_format = 1), provider_id varchar(128) NOT NULL,
 kek_ref varchar(128) NOT NULL, kek_version integer NOT NULL CHECK (kek_version > 0),
 wrapped_dek bytea NOT NULL CHECK (octet_length(wrapped_dek) BETWEEN 48 AND 65536),
 state varchar(16) NOT NULL CHECK (state IN ('pending','active','decrypt-only','retired','revoked','deleted')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (user_id, dek_version), UNIQUE (user_id, dek_id)
);
CREATE UNIQUE INDEX user_data_keys_one_active ON app.user_data_keys (user_id) WHERE state = 'active';
GRANT SELECT, INSERT, UPDATE, DELETE ON app.user_data_keys TO forja_app;
`);
exports.down = () => { throw new Error('Forward recovery required: wrapped-key deletion is not an automatic rollback'); };
