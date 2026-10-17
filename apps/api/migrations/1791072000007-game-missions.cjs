exports.up=pgm=>pgm.sql(`
CREATE TABLE app.game_mission_history (
 user_id uuid NOT NULL REFERENCES app.users(id),id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),source_id uuid NOT NULL,
 assigned_at varchar(24) NOT NULL,expires_at varchar(24) NOT NULL,recorded_at varchar(24) NOT NULL,
 dek_id uuid NOT NULL,dek_version integer NOT NULL CHECK(dek_version>0),payload text NOT NULL CHECK(octet_length(payload)<=16384),
 PRIMARY KEY(user_id,id,revision),FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE TABLE app.game_missions (
 user_id uuid NOT NULL,id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),source_id uuid NOT NULL,
 assigned_at varchar(24) NOT NULL,expires_at varchar(24) NOT NULL,updated_at varchar(24) NOT NULL,
 PRIMARY KEY(user_id,id),UNIQUE(user_id,source_id),FOREIGN KEY(user_id,id,revision) REFERENCES app.game_mission_history(user_id,id,revision)
);
CREATE TABLE app.game_awards (
 user_id uuid NOT NULL,mission_id uuid NOT NULL,mission_revision integer NOT NULL CHECK(mission_revision>0),seq integer NOT NULL CHECK(seq>0),
 revision integer NOT NULL CHECK(revision=1),recorded_at varchar(24) NOT NULL,dek_id uuid NOT NULL,dek_version integer NOT NULL CHECK(dek_version>0),payload text NOT NULL CHECK(octet_length(payload)<=4096),
 PRIMARY KEY(user_id,mission_id),UNIQUE(user_id,seq),FOREIGN KEY(user_id,mission_id,mission_revision) REFERENCES app.game_mission_history(user_id,id,revision),
 FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE TABLE app.game_progression (
 user_id uuid PRIMARY KEY,seq integer NOT NULL CHECK(seq>0),FOREIGN KEY(user_id,seq) REFERENCES app.game_awards(user_id,seq)
);
CREATE FUNCTION app.game_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_setting('forja.erase_user',true)=OLD.user_id::text AND EXISTS(SELECT 1 FROM app.users WHERE id=OLD.user_id AND status='deletion-requested') THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Immutable game evidence';
END $$;
`+['game_mission_history','game_awards'].map(t=>`CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON app.${t} FOR EACH ROW EXECUTE FUNCTION app.game_immutable();`).join('')+
['game_missions','game_mission_history','game_awards','game_progression'].map(t=>`
ALTER TABLE app.${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${t}_owner ON app.${t} TO forja_app USING(user_id::text=current_setting('forja.user_id',true)) WITH CHECK(user_id::text=current_setting('forja.user_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON app.${t} TO forja_app;
`).join(''));
exports.down=()=>{throw new Error('Forward recovery required: game audit cannot be automatically deleted');};
