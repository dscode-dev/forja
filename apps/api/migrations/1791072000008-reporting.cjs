exports.up=pgm=>pgm.sql(`
CREATE TABLE app.report_requests (
 user_id uuid NOT NULL REFERENCES app.users(id),id uuid NOT NULL,generation integer NOT NULL CHECK(generation>0),revision integer NOT NULL CHECK(revision=1),
 recorded_at varchar(24) NOT NULL,expires_at varchar(24) NOT NULL,
 dek_id uuid NOT NULL,dek_version integer NOT NULL CHECK(dek_version>0),payload text NOT NULL CHECK(octet_length(payload)<=8192),
 PRIMARY KEY(user_id,id),UNIQUE(user_id,generation),FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE TABLE app.report_snapshots (
 user_id uuid NOT NULL,id uuid NOT NULL,revision integer NOT NULL CHECK(revision=1),recorded_at varchar(24) NOT NULL,expires_at varchar(24) NOT NULL,
 dek_id uuid NOT NULL,dek_version integer NOT NULL CHECK(dek_version>0),payload text NOT NULL CHECK(octet_length(payload)<=1048576),
 PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,id) REFERENCES app.report_requests(user_id,id),FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE INDEX report_snapshots_expiry ON app.report_snapshots(expires_at,user_id,id);
CREATE INDEX finance_events_report_day ON app.finance_events(user_id,account_id,(left(effective_at,10)),seq DESC);
CREATE INDEX game_awards_report_time ON app.game_awards(user_id,recorded_at,seq);
CREATE FUNCTION app.report_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND ((current_setting('forja.erase_user',true)=OLD.user_id::text AND EXISTS(SELECT 1 FROM app.users WHERE id=OLD.user_id AND status='deletion-requested')) OR (TG_TABLE_NAME='report_snapshots' AND (current_setting('forja.delete_report',true)=OLD.id::text OR OLD.expires_at<=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Immutable report evidence'; END $$;
`+['report_requests','report_snapshots'].map(t=>`
ALTER TABLE app.${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${t}_owner ON app.${t} TO forja_app USING(user_id::text=current_setting('forja.user_id',true)) WITH CHECK(user_id::text=current_setting('forja.user_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON app.${t} TO forja_app;
CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON app.${t} FOR EACH ROW EXECUTE FUNCTION app.report_immutable();
`).join(''));
exports.down=()=>{throw new Error('Forward recovery required: report command audit cannot be automatically deleted');};
