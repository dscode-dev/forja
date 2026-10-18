exports.up=pgm=>pgm.sql(`
CREATE TABLE app.ai_preference_history (
 user_id uuid NOT NULL REFERENCES app.users(id),revision integer NOT NULL CHECK(revision>0),enabled boolean NOT NULL,policy varchar(32) NOT NULL CHECK(policy='forja.ai.v1'),recorded_at varchar(24) NOT NULL,dek_id uuid NOT NULL,dek_version integer NOT NULL CHECK(dek_version>0),payload text NOT NULL CHECK(octet_length(payload)<=4096),
 PRIMARY KEY(user_id,revision),FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE TABLE app.ai_preferences (user_id uuid PRIMARY KEY,revision integer NOT NULL,FOREIGN KEY(user_id,revision) REFERENCES app.ai_preference_history(user_id,revision));
CREATE TABLE app.ai_executions (
 user_id uuid NOT NULL REFERENCES app.users(id),id uuid NOT NULL,report_id uuid NOT NULL,report_generation integer NOT NULL CHECK(report_generation>0),consent_revision integer NOT NULL CHECK(consent_revision>0),
 prompt_version integer NOT NULL CHECK(prompt_version=1),config_version varchar(64) NOT NULL CHECK(config_version='openai-responses-gpt54mini-v1'),attempt integer NOT NULL CHECK(attempt>0),
 state varchar(16) NOT NULL CHECK(state IN('RUNNING','SUCCEEDED','FAILED','CANCELLED')),revision integer NOT NULL CHECK(revision IN(1,2)),
 started_at varchar(24) NOT NULL,updated_at varchar(24) NOT NULL,deadline varchar(24) NOT NULL,expires_at varchar(24) NOT NULL,
 dek_id uuid NOT NULL,dek_version integer NOT NULL CHECK(dek_version>0),payload text NOT NULL CHECK(octet_length(payload)<=32768),
 PRIMARY KEY(user_id,id),UNIQUE(user_id,report_id,consent_revision,prompt_version,config_version,attempt),
 FOREIGN KEY(user_id,report_id) REFERENCES app.report_requests(user_id,id),FOREIGN KEY(user_id,consent_revision) REFERENCES app.ai_preference_history(user_id,revision),FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id),
 CHECK((state='RUNNING' AND revision=1) OR (state<>'RUNNING' AND revision=2))
);
CREATE INDEX ai_execution_expiry ON app.ai_executions(user_id,expires_at);
CREATE TABLE app.ai_request_receipts (
 user_id uuid NOT NULL REFERENCES app.users(id),id uuid NOT NULL,execution_id uuid NOT NULL,dispatched_at varchar(24),revision integer NOT NULL CHECK(revision=1),recorded_at varchar(24) NOT NULL,
 dek_id uuid NOT NULL,dek_version integer NOT NULL CHECK(dek_version>0),payload text NOT NULL CHECK(octet_length(payload)<=4096),
 PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE INDEX ai_dispatch_quota ON app.ai_request_receipts(user_id,dispatched_at) WHERE dispatched_at IS NOT NULL;
CREATE FUNCTION app.ai_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN
  IF current_setting('forja.erase_user',true)=OLD.user_id::text AND EXISTS(SELECT 1 FROM app.users WHERE id=OLD.user_id AND status='deletion-requested') THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='ai_executions' THEN
   IF current_setting('forja.delete_ai',true)=OLD.id::text OR OLD.expires_at<=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN RETURN OLD; END IF;
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='ai_executions' THEN
  IF OLD.state='RUNNING' AND NEW.state IN('SUCCEEDED','FAILED','CANCELLED') AND NEW.revision=OLD.revision+1 AND (to_jsonb(OLD)-ARRAY['state','revision','updated_at','dek_id','dek_version','payload'])=(to_jsonb(NEW)-ARRAY['state','revision','updated_at','dek_id','dek_version','payload']) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Immutable AI evidence'; END $$;
`+['ai_preference_history','ai_executions','ai_request_receipts'].map(t=>`CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON app.${t} FOR EACH ROW EXECUTE FUNCTION app.ai_immutable();`).join('')+
['ai_preference_history','ai_preferences','ai_executions','ai_request_receipts'].map(t=>`
ALTER TABLE app.${t} ENABLE ROW LEVEL SECURITY;ALTER TABLE app.${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${t}_owner ON app.${t} TO forja_app USING(user_id::text=current_setting('forja.user_id',true)) WITH CHECK(user_id::text=current_setting('forja.user_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON app.${t} TO forja_app;
`).join(''));
exports.down=()=>{throw new Error('Forward recovery required: AI consent and execution audit cannot be automatically deleted');};
