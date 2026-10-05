exports.up = pgm => pgm.sql(`
CREATE TABLE app.users (
 id uuid PRIMARY KEY, issuer varchar(512), subject varchar(255),
 status varchar(24) NOT NULL CHECK (status IN ('pending','active','suspended','deletion-requested','deleted')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(issuer,subject), CHECK(subject ~ '^[A-Za-z0-9._:-]{1,255}$'),
 CHECK((status='deleted' AND issuer IS NULL AND subject IS NULL) OR (status<>'deleted' AND issuer IS NOT NULL AND subject IS NOT NULL))
);
ALTER TABLE app.user_data_keys ADD CONSTRAINT key_owner FOREIGN KEY(user_id) REFERENCES app.users(id);
CREATE TABLE app.user_profiles (
 user_id uuid PRIMARY KEY REFERENCES app.users(id), dek_id uuid NOT NULL, dek_version integer NOT NULL CHECK(dek_version>0),
 revision integer NOT NULL CHECK(revision>0), payload text NOT NULL CHECK(octet_length(payload)<=4096),
 locale varchar(35) NOT NULL, timezone varchar(64) NOT NULL, preferred_currency char(3) NOT NULL CHECK(preferred_currency ~ '^[A-Z]{3}$'),
 onboarding_state varchar(16) NOT NULL CHECK(onboarding_state IN ('pending','complete')),
 FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
ALTER TABLE app.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_owner ON app.user_profiles TO forja_app USING(user_id::text=current_setting('forja.user_id',true)) WITH CHECK(user_id::text=current_setting('forja.user_id',true));
CREATE TABLE app.security_events (
 id uuid PRIMARY KEY,user_id uuid REFERENCES app.users(id),event varchar(32) NOT NULL CHECK(event IN ('account.created','login.succeeded','login.failed','session.revoked','session.refreshed','sessions.revoked','account.suspended','deletion.requested','account.deleted','profile.updated')),
 result varchar(16) NOT NULL CHECK(result IN ('success','rejected','unavailable')), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX security_events_retention ON app.security_events(created_at);
GRANT SELECT,INSERT,UPDATE ON app.users TO forja_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.user_profiles TO forja_app;
GRANT INSERT,DELETE ON app.security_events TO forja_app;
`);
exports.down = () => { throw new Error('Forward recovery required: identity and encrypted profiles cannot be automatically deleted'); };
