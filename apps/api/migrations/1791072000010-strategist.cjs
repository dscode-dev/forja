exports.up=pgm=>pgm.sql(`
CREATE TABLE app.ai_strategy_subjects(user_id uuid NOT NULL REFERENCES app.users(id),id uuid NOT NULL,revision integer NOT NULL CHECK(revision=1),recorded_at varchar(24) NOT NULL,expires_at varchar(24) NOT NULL,dek_id uuid NOT NULL,dek_version integer NOT NULL,payload text NOT NULL CHECK(octet_length(payload)<=8192),PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id));
CREATE TABLE app.ai_strategy_decisions(user_id uuid NOT NULL REFERENCES app.users(id),execution_id uuid NOT NULL,revision integer NOT NULL CHECK(revision=1),recorded_at varchar(24) NOT NULL,dek_id uuid NOT NULL,dek_version integer NOT NULL,payload text NOT NULL CHECK(octet_length(payload)<=8192),PRIMARY KEY(user_id,execution_id),FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id));
CREATE FUNCTION app.strategy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN
  IF current_setting('forja.erase_user',true)=OLD.user_id::text AND EXISTS(SELECT 1 FROM app.users WHERE id=OLD.user_id AND status='deletion-requested') THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='ai_strategy_subjects' THEN
   IF OLD.expires_at<=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN RETURN OLD; END IF;
  END IF;
 END IF;RAISE EXCEPTION 'Immutable strategy evidence'; END $$;
ALTER TABLE app.ai_executions DROP CONSTRAINT ai_executions_user_id_report_id_fkey;
ALTER TABLE app.ai_executions DROP CONSTRAINT ai_executions_config_version_check;
ALTER TABLE app.ai_executions ADD CHECK(config_version IN('openai-responses-gpt54mini-v1','openai-responses-strategist-v1'));
CREATE FUNCTION app.ai_source_exists() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.config_version='openai-responses-gpt54mini-v1' THEN
  IF NOT EXISTS(SELECT 1 FROM app.report_requests WHERE user_id=NEW.user_id AND id=NEW.report_id) THEN RAISE EXCEPTION 'Missing AI source'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM app.ai_strategy_subjects WHERE user_id=NEW.user_id AND id=NEW.report_id) THEN RAISE EXCEPTION 'Missing AI source'; END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER ai_source_exists BEFORE INSERT ON app.ai_executions FOR EACH ROW EXECUTE FUNCTION app.ai_source_exists();
`+['ai_strategy_subjects','ai_strategy_decisions'].map(t=>`
ALTER TABLE app.${t} ENABLE ROW LEVEL SECURITY;ALTER TABLE app.${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${t}_owner ON app.${t} TO forja_app USING(user_id::text=current_setting('forja.user_id',true)) WITH CHECK(user_id::text=current_setting('forja.user_id',true));GRANT SELECT,INSERT,UPDATE,DELETE ON app.${t} TO forja_app;
CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON app.${t} FOR EACH ROW EXECUTE FUNCTION app.strategy_immutable();`).join(''));
exports.down=()=>{throw new Error('Forward recovery required for strategy audit');};
