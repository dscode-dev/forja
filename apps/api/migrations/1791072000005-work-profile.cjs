exports.up = pgm => pgm.sql(`
CREATE TABLE app.work_profile_history (
 user_id uuid NOT NULL REFERENCES app.users(id), revision integer NOT NULL CHECK(revision>0),
 recorded_at varchar(24) NOT NULL, event varchar(16) NOT NULL CHECK(event IN ('created','updated','model-changed')),
 dek_id uuid NOT NULL, dek_version integer NOT NULL CHECK(dek_version>0), payload text NOT NULL CHECK(octet_length(payload)<=16384),
 PRIMARY KEY(user_id,revision), FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE TABLE app.work_profiles (
 user_id uuid PRIMARY KEY REFERENCES app.users(id), revision integer NOT NULL CHECK(revision>0),
 FOREIGN KEY(user_id,revision) REFERENCES app.work_profile_history(user_id,revision)
);
CREATE FUNCTION app.work_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_setting('forja.erase_user',true)=OLD.user_id::text AND EXISTS(SELECT 1 FROM app.users WHERE id=OLD.user_id AND status='deletion-requested') THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Immutable work history';
END $$;
CREATE TRIGGER work_history_immutable BEFORE UPDATE OR DELETE ON app.work_profile_history FOR EACH ROW EXECUTE FUNCTION app.work_history_immutable();
` + ['work_profiles','work_profile_history'].map(table => `
ALTER TABLE app.${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_owner ON app.${table} TO forja_app USING(user_id::text=current_setting('forja.user_id',true)) WITH CHECK(user_id::text=current_setting('forja.user_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON app.${table} TO forja_app;
`).join(''));
exports.down = () => { throw new Error('Forward recovery required: work history cannot be automatically deleted'); };
