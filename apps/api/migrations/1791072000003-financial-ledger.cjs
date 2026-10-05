exports.up = pgm => pgm.sql(`
CREATE TABLE app.finance_streams (
 user_id uuid PRIMARY KEY REFERENCES app.users(id), seq bigint NOT NULL CHECK(seq>=0 AND seq<=9007199254740990),
 revision integer NOT NULL CHECK(revision>0), dek_id uuid NOT NULL, dek_version integer NOT NULL CHECK(dek_version>0), payload text NOT NULL CHECK(octet_length(payload)<=16384),
 FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE TABLE app.finance_accounts (
 user_id uuid NOT NULL REFERENCES app.users(id), id uuid NOT NULL, currency varchar(3) NOT NULL CHECK(currency IN ('BRL','USD','EUR','JPY','KWD')),
 state varchar(8) NOT NULL CHECK(state IN ('active','closed')), last_seq bigint NOT NULL CHECK(last_seq>0),
 revision integer NOT NULL CHECK(revision>0), dek_id uuid NOT NULL, dek_version integer NOT NULL CHECK(dek_version>0), payload text NOT NULL CHECK(octet_length(payload)<=16384),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,id,currency), FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE TABLE app.finance_events (
 user_id uuid NOT NULL, id uuid NOT NULL, seq bigint NOT NULL CHECK(seq>0), account_id uuid NOT NULL, currency varchar(3) NOT NULL,
 effective_at varchar(24) NOT NULL, recorded_at varchar(24) NOT NULL, reversal_of uuid, replacement_of uuid, expected_id uuid,
 revision integer NOT NULL CHECK(revision=1), dek_id uuid NOT NULL, dek_version integer NOT NULL CHECK(dek_version>0), payload text NOT NULL CHECK(octet_length(payload)<=16384),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,seq), UNIQUE(user_id,reversal_of), UNIQUE(user_id,replacement_of), UNIQUE(user_id,expected_id),
 FOREIGN KEY(user_id,account_id,currency) REFERENCES app.finance_accounts(user_id,id,currency),
 FOREIGN KEY(user_id,reversal_of) REFERENCES app.finance_events(user_id,id), FOREIGN KEY(user_id,replacement_of) REFERENCES app.finance_events(user_id,id),
 FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id), CHECK(reversal_of IS NULL OR replacement_of IS NULL)
);
CREATE INDEX finance_history ON app.finance_events(user_id,account_id,seq);
CREATE INDEX finance_period ON app.finance_events(user_id,account_id,effective_at,seq);
CREATE TABLE app.finance_checkpoints (
 user_id uuid NOT NULL, seq bigint NOT NULL CHECK(seq>0), revision integer NOT NULL CHECK(revision=1),
 dek_id uuid NOT NULL, dek_version integer NOT NULL CHECK(dek_version>0), payload text NOT NULL CHECK(octet_length(payload)<=16384),
 PRIMARY KEY(user_id,seq), FOREIGN KEY(user_id,seq) REFERENCES app.finance_events(user_id,seq), FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE TABLE app.finance_buckets (
 user_id uuid NOT NULL, account_id uuid NOT NULL, currency varchar(3) NOT NULL, day varchar(10) NOT NULL, month varchar(7) NOT NULL, last_seq bigint NOT NULL CHECK(last_seq>0),
 revision integer NOT NULL CHECK(revision>0), dek_id uuid NOT NULL, dek_version integer NOT NULL CHECK(dek_version>0), payload text NOT NULL CHECK(octet_length(payload)<=16384),
 PRIMARY KEY(user_id,account_id,day), FOREIGN KEY(user_id,account_id,currency) REFERENCES app.finance_accounts(user_id,id,currency), FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE INDEX finance_month ON app.finance_buckets(user_id,account_id,month,day);
CREATE TABLE app.finance_receipts (
 user_id uuid NOT NULL REFERENCES app.users(id), kind varchar(32) NOT NULL CHECK(kind IN ('account.create','account.close','posting.income','posting.expense','posting.reverse','posting.correct','expected.create','expected.cancel','expected.settle')),
 id uuid NOT NULL, revision integer NOT NULL CHECK(revision=1), dek_id uuid NOT NULL, dek_version integer NOT NULL CHECK(dek_version>0), payload text NOT NULL CHECK(octet_length(payload)<=16384),
 PRIMARY KEY(user_id,kind,id), FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE TABLE app.finance_anchor_outbox (
 user_id uuid NOT NULL, seq bigint NOT NULL, PRIMARY KEY(user_id,seq), FOREIGN KEY(user_id,seq) REFERENCES app.finance_checkpoints(user_id,seq)
);
CREATE TABLE app.planning_expected (
 user_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL, currency varchar(3) NOT NULL, due_at varchar(24) NOT NULL,
 state varchar(12) NOT NULL CHECK(state IN ('pending','settled','cancelled')), settlement_id uuid,
 revision integer NOT NULL CHECK(revision>0), dek_id uuid NOT NULL, dek_version integer NOT NULL CHECK(dek_version>0), payload text NOT NULL CHECK(octet_length(payload)<=16384),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,settlement_id), FOREIGN KEY(user_id,account_id,currency) REFERENCES app.finance_accounts(user_id,id,currency),
 FOREIGN KEY(user_id,settlement_id) REFERENCES app.finance_events(user_id,id), FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id),
 CHECK((state='settled')=(settlement_id IS NOT NULL))
);
CREATE TABLE app.planning_expected_events (
 user_id uuid NOT NULL, id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 dek_id uuid NOT NULL, dek_version integer NOT NULL CHECK(dek_version>0), payload text NOT NULL CHECK(octet_length(payload)<=16384),
 PRIMARY KEY(user_id,id,revision), FOREIGN KEY(user_id,id) REFERENCES app.planning_expected(user_id,id), FOREIGN KEY(user_id,dek_id) REFERENCES app.user_data_keys(user_id,dek_id)
);
CREATE INDEX planning_due ON app.planning_expected(user_id,account_id,state,due_at,id);
CREATE FUNCTION app.financial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_setting('forja.erase_user',true)=OLD.user_id::text AND EXISTS(SELECT 1 FROM app.users WHERE id=OLD.user_id AND status='deletion-requested') THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Immutable financial history';
END $$;
CREATE TRIGGER expected_events_immutable BEFORE UPDATE OR DELETE ON app.planning_expected_events FOR EACH ROW EXECUTE FUNCTION app.financial_immutable();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON app.finance_events FOR EACH ROW EXECUTE FUNCTION app.financial_immutable();
CREATE TRIGGER checkpoints_immutable BEFORE UPDATE OR DELETE ON app.finance_checkpoints FOR EACH ROW EXECUTE FUNCTION app.financial_immutable();
CREATE TRIGGER receipts_immutable BEFORE UPDATE OR DELETE ON app.finance_receipts FOR EACH ROW EXECUTE FUNCTION app.financial_immutable();
` + ['finance_streams','finance_accounts','finance_events','finance_checkpoints','finance_buckets','finance_receipts','finance_anchor_outbox','planning_expected','planning_expected_events'].map(table => `
ALTER TABLE app.${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_owner ON app.${table} TO forja_app USING(user_id::text=current_setting('forja.user_id',true)) WITH CHECK(user_id::text=current_setting('forja.user_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON app.${table} TO forja_app;
`).join(''));
exports.down = () => { throw new Error('Forward recovery required: financial history cannot be automatically deleted'); };
