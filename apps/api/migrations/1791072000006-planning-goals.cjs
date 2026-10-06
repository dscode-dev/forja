exports.up=pgm=>pgm.sql(`
CREATE TABLE app.planning_goal_history (
 user_id uuid NOT NULL REFERENCES app.users(id),id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 account_id uuid NOT NULL,currency varchar(3) NOT NULL,allocation varchar(8) NOT NULL CHECK(allocation IN ('reserved','released')),
 created_at varchar(24) NOT NULL,recorded_at varchar(24) NOT NULL,
 dek_id uuid NOT NULL,dek_version integer NOT NULL CHECK(dek_version>0),payload text NOT NULL CHECK(octet_length(payload)<=16384),
 PRIMARY KEY(user_id,id,revision),FOREIGN KEY(user_id,account_id,currency) REFERENCES app.finance_accounts(user_id,id,currency),
 FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE TABLE app.planning_goals (
 user_id uuid NOT NULL,id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),account_id uuid NOT NULL,currency varchar(3) NOT NULL,
 allocation varchar(8) NOT NULL CHECK(allocation IN ('reserved','released')),created_at varchar(24) NOT NULL,updated_at varchar(24) NOT NULL,
 PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,id,revision) REFERENCES app.planning_goal_history(user_id,id,revision),
 FOREIGN KEY(user_id,account_id,currency) REFERENCES app.finance_accounts(user_id,id,currency)
);
CREATE UNIQUE INDEX planning_goal_account_reservation ON app.planning_goals(user_id,account_id) WHERE allocation='reserved';
CREATE TABLE app.planning_goal_calculations (
 user_id uuid NOT NULL,id uuid NOT NULL,goal_id uuid NOT NULL,goal_revision integer NOT NULL CHECK(goal_revision>0),generation integer NOT NULL CHECK(generation>0),
 revision integer NOT NULL CHECK(revision=1),formula integer NOT NULL CHECK(formula=1),work_revision integer CHECK(work_revision>0),
 identity_revision integer NOT NULL CHECK(identity_revision>0),finance_cursor bigint NOT NULL CHECK(finance_cursor>0 AND finance_cursor<=9007199254740991),recorded_at varchar(24) NOT NULL,
 dek_id uuid NOT NULL,dek_version integer NOT NULL CHECK(dek_version>0),payload text NOT NULL CHECK(octet_length(payload)<=1500000),
 PRIMARY KEY(user_id,id),UNIQUE(user_id,goal_id,id),UNIQUE(user_id,goal_id,generation),FOREIGN KEY(user_id,goal_id) REFERENCES app.planning_goals(user_id,id),
 FOREIGN KEY(user_id,goal_id,goal_revision) REFERENCES app.planning_goal_history(user_id,id,revision),FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE TABLE app.planning_goal_receipts (
 user_id uuid NOT NULL,kind varchar(12) NOT NULL CHECK(kind IN ('create','revise','transition','calculate')),id uuid NOT NULL,
 goal_id uuid NOT NULL,goal_revision integer NOT NULL CHECK(goal_revision>0),calculation_id uuid,
 revision integer NOT NULL CHECK(revision=1),dek_id uuid NOT NULL,dek_version integer NOT NULL CHECK(dek_version>0),payload text NOT NULL CHECK(octet_length(payload)<=4096),
 PRIMARY KEY(user_id,kind,id),FOREIGN KEY(user_id,goal_id,goal_revision) REFERENCES app.planning_goal_history(user_id,id,revision),
 FOREIGN KEY(user_id,goal_id,calculation_id) REFERENCES app.planning_goal_calculations(user_id,goal_id,id),
 FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id),CHECK((kind='calculate')=(calculation_id IS NOT NULL))
);
CREATE FUNCTION app.planning_goal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_setting('forja.erase_user',true)=OLD.user_id::text AND EXISTS(SELECT 1 FROM app.users WHERE id=OLD.user_id AND status='deletion-requested') THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Immutable planning evidence';
END $$;
`+['planning_goal_history','planning_goal_calculations','planning_goal_receipts'].map(t=>`CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON app.${t} FOR EACH ROW EXECUTE FUNCTION app.planning_goal_immutable();`).join('')+
['planning_goals','planning_goal_history','planning_goal_calculations','planning_goal_receipts'].map(t=>`
ALTER TABLE app.${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${t}_owner ON app.${t} TO forja_app USING(user_id::text=current_setting('forja.user_id',true)) WITH CHECK(user_id::text=current_setting('forja.user_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON app.${t} TO forja_app;
`).join(''));
exports.down=()=>{throw new Error('Forward recovery required: planning evidence cannot be automatically deleted');};
