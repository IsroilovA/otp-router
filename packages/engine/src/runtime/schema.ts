import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

// Installed once by the fresh-database baseline. Views only assemble read models;
// ownership, memberships, revision references and credentials live in typed tables.
export const runtimeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE otp_router.allowance_scopes (
    id text PRIMARY KEY, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    send_limit_15m integer NOT NULL CHECK (send_limit_15m > 0),
    send_limit_24h integer NOT NULL CHECK (send_limit_24h > 0)
  )`;
  yield* sql`CREATE TABLE otp_router.provider_accounts (
    id text PRIMARY KEY, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
    state text NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled','enabled','retired')),
    epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0),
    adapter_id text NOT NULL, schema_version text NOT NULL, identity jsonb NOT NULL
  )`;
  yield* sql`CREATE TABLE otp_router.provider_instances (
    id text PRIMARY KEY, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
    configuration_revision integer NOT NULL DEFAULT 1 CHECK (configuration_revision > 0),
    state text NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled','enabled','retired')),
    epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0),
    account_id text NOT NULL REFERENCES otp_router.provider_accounts(id), UNIQUE(id,account_id)
  )`;
  yield* sql`CREATE TABLE otp_router.instance_revisions (
    instance_id text NOT NULL REFERENCES otp_router.provider_instances(id), revision integer NOT NULL CHECK (revision > 0),
    settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'), invalidated boolean NOT NULL DEFAULT false,
    PRIMARY KEY(instance_id,revision)
  )`;
  yield* sql`ALTER TABLE otp_router.provider_instances ADD FOREIGN KEY(id,configuration_revision)
    REFERENCES otp_router.instance_revisions(instance_id,revision) DEFERRABLE INITIALLY DEFERRED`;
  yield* sql`CREATE TABLE otp_router.routing_policies (
    id text PRIMARY KEY, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    configuration_revision integer NOT NULL DEFAULT 1 CHECK (configuration_revision > 0),
    state text NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled','enabled','retired')),
    epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0)
  )`;
  yield* sql`CREATE TABLE otp_router.policy_revisions (
    policy_id text NOT NULL REFERENCES otp_router.routing_policies(id), revision integer NOT NULL CHECK (revision > 0),
    created_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
    settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object' AND NOT settings ?| ARRAY['providerInstanceIds','manualProviderIds']),
    invalidated boolean NOT NULL DEFAULT false, PRIMARY KEY(policy_id,revision)
  )`;
  yield* sql`ALTER TABLE otp_router.routing_policies ADD FOREIGN KEY(id,configuration_revision)
    REFERENCES otp_router.policy_revisions(policy_id,revision) DEFERRABLE INITIALLY DEFERRED`;
  yield* sql`CREATE TABLE otp_router.policy_steps (
    policy_id text NOT NULL, revision integer NOT NULL, position integer NOT NULL CHECK (position >= 0),
    instance_id text NOT NULL REFERENCES otp_router.provider_instances(id), manual_selection_allowed boolean NOT NULL,
    PRIMARY KEY(policy_id,revision,position), UNIQUE(policy_id,revision,instance_id),
    FOREIGN KEY(policy_id,revision) REFERENCES otp_router.policy_revisions(policy_id,revision)
  )`;
  yield* sql`CREATE INDEX policy_steps_instance ON otp_router.policy_steps(instance_id)`;
  yield* sql`CREATE TABLE otp_router.account_allowances (
    account_id text NOT NULL REFERENCES otp_router.provider_accounts(id), scope_id text NOT NULL REFERENCES otp_router.allowance_scopes(id),
    PRIMARY KEY(account_id,scope_id)
  )`;
  yield* sql`CREATE TABLE otp_router.instance_allowances (
    instance_id text NOT NULL REFERENCES otp_router.provider_instances(id), scope_id text NOT NULL REFERENCES otp_router.allowance_scopes(id),
    PRIMARY KEY(instance_id,scope_id)
  )`;
  yield* sql`CREATE INDEX account_allowances_scope ON otp_router.account_allowances(scope_id)`;
  yield* sql`CREATE INDEX instance_allowances_scope ON otp_router.instance_allowances(scope_id)`;
  yield* sql`CREATE TABLE otp_router.account_secret_versions (
    id text PRIMARY KEY, account_id text NOT NULL REFERENCES otp_router.provider_accounts(id),
    purpose text NOT NULL CHECK (purpose IN ('send','callback')), ciphertext jsonb,
    revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(account_id,purpose,id)
  )`;
  yield* sql`CREATE TABLE otp_router.account_current_secrets (
    account_id text NOT NULL, purpose text NOT NULL, version_id text NOT NULL,
    PRIMARY KEY(account_id,purpose), FOREIGN KEY(account_id,purpose,version_id)
      REFERENCES otp_router.account_secret_versions(account_id,purpose,id)
  )`;
  yield* sql`CREATE INDEX account_secrets_purpose ON otp_router.account_secret_versions(account_id,purpose,created_at)`;
  yield* sql`CREATE TABLE otp_router.runtime_receipts (
    actor_id text NOT NULL, key text NOT NULL, fingerprint jsonb NOT NULL, response jsonb NOT NULL, PRIMARY KEY(actor_id,key)
  )`;

  yield* sql`CREATE VIEW otp_router.policy_configurations AS
    SELECT p.policy_id,p.revision,p.invalidated,p.settings || jsonb_build_object(
      'providerInstanceIds',COALESCE((SELECT jsonb_agg(s.instance_id ORDER BY s.position) FROM otp_router.policy_steps s WHERE (s.policy_id,s.revision) = (p.policy_id,p.revision)),'[]'::jsonb),
      'manualProviderIds',COALESCE((SELECT jsonb_agg(s.instance_id ORDER BY s.position) FROM otp_router.policy_steps s WHERE (s.policy_id,s.revision) = (p.policy_id,p.revision) AND s.manual_selection_allowed),'[]'::jsonb)
    ) AS settings FROM otp_router.policy_revisions p`;
  yield* sql`CREATE VIEW otp_router.runtime_resources AS
    SELECT a.id,'account'::text AS kind,a.revision,1 AS configuration_revision,a.epoch,a.state,
      jsonb_build_object('kind','account','adapterId',a.adapter_id,'schemaVersion',a.schema_version,'identity',a.identity,
        'scopeIds',COALESCE((SELECT jsonb_agg(m.scope_id ORDER BY m.scope_id) FROM otp_router.account_allowances m WHERE m.account_id = a.id),'[]'::jsonb)) AS data,
      (SELECT version_id FROM otp_router.account_current_secrets c WHERE c.account_id = a.id AND c.purpose = 'send') AS send_version,
      (SELECT version_id FROM otp_router.account_current_secrets c WHERE c.account_id = a.id AND c.purpose = 'callback') AS callback_version
    FROM otp_router.provider_accounts a
    UNION ALL
    SELECT i.id,'instance',i.revision,i.configuration_revision,i.epoch,i.state,
      jsonb_build_object('kind','instance','accountId',i.account_id,'settings',v.settings,
        'scopeIds',COALESCE((SELECT jsonb_agg(m.scope_id ORDER BY m.scope_id) FROM otp_router.instance_allowances m WHERE m.instance_id = i.id),'[]'::jsonb)),NULL,NULL
    FROM otp_router.provider_instances i JOIN otp_router.instance_revisions v ON (v.instance_id,v.revision) = (i.id,i.configuration_revision)
    UNION ALL
    SELECT p.id,'policy',p.revision,p.configuration_revision,p.epoch,p.state,
      jsonb_build_object('kind','policy','settings',v.settings),NULL,NULL
    FROM otp_router.routing_policies p JOIN otp_router.policy_configurations v ON (v.policy_id,v.revision) = (p.id,p.configuration_revision)
    UNION ALL
    SELECT s.id,'scope',s.revision,0,0,NULL,
      jsonb_build_object('kind','scope','limits',jsonb_build_object('sendLimit15m',s.send_limit_15m,'sendLimit24h',s.send_limit_24h)),NULL,NULL
    FROM otp_router.allowance_scopes s`;
  yield* sql`CREATE VIEW otp_router.runtime_revisions AS
    SELECT 'instance'::text AS kind,i.id AS resource_id,v.revision,v.invalidated,
      jsonb_build_object('kind','instance','accountId',i.account_id,'settings',v.settings,
        'scopeIds',COALESCE((SELECT jsonb_agg(m.scope_id ORDER BY m.scope_id) FROM otp_router.instance_allowances m WHERE m.instance_id = i.id),'[]'::jsonb)) AS data
    FROM otp_router.instance_revisions v JOIN otp_router.provider_instances i ON i.id = v.instance_id
    UNION ALL
    SELECT 'policy',policy_id,revision,invalidated,jsonb_build_object('kind','policy','settings',settings) FROM otp_router.policy_configurations
    UNION ALL SELECT 'account',id,1,false,data FROM otp_router.runtime_resources WHERE kind = 'account'`;

  for (const table of [
    "provider_accounts",
    "provider_instances",
    "routing_policies",
    "allowance_scopes",
  ]) {
    yield* sql`CREATE TRIGGER reserved_identity BEFORE DELETE ON ${sql(`otp_router.${table}`)} FOR EACH ROW EXECUTE FUNCTION otp_router.reject_identity_change()`;
    yield* sql`CREATE TRIGGER immutable_id BEFORE UPDATE ON ${sql(`otp_router.${table}`)} FOR EACH ROW WHEN (OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION otp_router.reject_identity_change()`;
  }
  for (const table of ["provider_accounts", "provider_instances", "routing_policies"])
    yield* sql`CREATE TRIGGER irreversible_retirement BEFORE UPDATE ON ${sql(`otp_router.${table}`)} FOR EACH ROW WHEN (OLD.state = 'retired' AND NEW.state <> 'retired') EXECUTE FUNCTION otp_router.reject_identity_change()`;
  yield* sql`CREATE TRIGGER immutable_account BEFORE UPDATE ON otp_router.provider_accounts FOR EACH ROW
    WHEN ((OLD.adapter_id,OLD.schema_version,OLD.identity,OLD.created_transaction) IS DISTINCT FROM (NEW.adapter_id,NEW.schema_version,NEW.identity,NEW.created_transaction)) EXECUTE FUNCTION otp_router.reject_identity_change()`;
  yield* sql`CREATE TRIGGER immutable_instance_account BEFORE UPDATE ON otp_router.provider_instances FOR EACH ROW
    WHEN ((OLD.account_id,OLD.created_transaction) IS DISTINCT FROM (NEW.account_id,NEW.created_transaction)) EXECUTE FUNCTION otp_router.reject_identity_change()`;
  // Child rows may be assembled only in the transaction that creates their owner.
  // Protect inserts as well as edits: appending a membership would change a saved revision.
  yield* sql`CREATE FUNCTION otp_router.check_membership_creation() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE sealed boolean;
    BEGIN
      CASE TG_TABLE_NAME
        WHEN 'account_allowances' THEN SELECT created_transaction <> pg_current_xact_id() INTO sealed FROM otp_router.provider_accounts WHERE id = NEW.account_id;
        WHEN 'instance_allowances' THEN SELECT created_transaction <> pg_current_xact_id() INTO sealed FROM otp_router.provider_instances WHERE id = NEW.instance_id;
        WHEN 'policy_steps' THEN SELECT created_transaction <> pg_current_xact_id() INTO sealed FROM otp_router.policy_revisions WHERE policy_id = NEW.policy_id AND revision = NEW.revision;
      END CASE;
      IF sealed THEN RAISE EXCEPTION 'Membership is immutable after creation' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END
  $$`;
  for (const table of ["account_allowances", "instance_allowances", "policy_steps"])
    yield* sql`CREATE TRIGGER sealed_membership BEFORE INSERT ON ${sql(`otp_router.${table}`)} FOR EACH ROW EXECUTE FUNCTION otp_router.check_membership_creation()`;
  for (const table of ["account_allowances", "instance_allowances", "policy_steps"])
    yield* sql`CREATE TRIGGER immutable_membership BEFORE UPDATE OR DELETE ON ${sql(`otp_router.${table}`)} FOR EACH ROW EXECUTE FUNCTION otp_router.reject_identity_change()`;
  for (const table of ["instance_revisions", "policy_revisions"]) {
    yield* sql`CREATE TRIGGER immutable_configuration BEFORE UPDATE ON ${sql(`otp_router.${table}`)} FOR EACH ROW
      WHEN ((to_jsonb(OLD) - 'invalidated') IS DISTINCT FROM (to_jsonb(NEW) - 'invalidated') OR (OLD.invalidated AND NOT NEW.invalidated)) EXECUTE FUNCTION otp_router.reject_identity_change()`;
    yield* sql`CREATE TRIGGER retained_configuration BEFORE DELETE ON ${sql(`otp_router.${table}`)} FOR EACH ROW EXECUTE FUNCTION otp_router.reject_identity_change()`;
  }
  yield* sql`CREATE TRIGGER immutable_secret_identity BEFORE UPDATE ON otp_router.account_secret_versions FOR EACH ROW
    WHEN ((OLD.id,OLD.account_id,OLD.purpose) IS DISTINCT FROM (NEW.id,NEW.account_id,NEW.purpose) OR (OLD.revoked AND NOT NEW.revoked)) EXECUTE FUNCTION otp_router.reject_identity_change()`;
});

// Projects must exist before their assignments and administrative events.
export const runtimeProjectSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE otp_router.runtime_grants (
    id text PRIMARY KEY, project_id text NOT NULL REFERENCES otp_router.projects(id),
    account_id text REFERENCES otp_router.provider_accounts(id), instance_id text REFERENCES otp_router.provider_instances(id),
    policy_id text REFERENCES otp_router.routing_policies(id),
    kind text GENERATED ALWAYS AS (CASE WHEN account_id IS NOT NULL THEN 'account' WHEN instance_id IS NOT NULL THEN 'instance' ELSE 'policy' END) STORED,
    resource_id text GENERATED ALWAYS AS (COALESCE(account_id,instance_id,policy_id)) STORED,
    revoked_at timestamptz, CHECK (num_nonnulls(account_id,instance_id,policy_id) = 1)
  )`;
  yield* sql`CREATE UNIQUE INDEX runtime_grants_active ON otp_router.runtime_grants(project_id,kind,resource_id) WHERE revoked_at IS NULL`;
  yield* sql`CREATE TRIGGER immutable_runtime_grant BEFORE UPDATE ON otp_router.runtime_grants FOR EACH ROW
    WHEN ((OLD.id,OLD.project_id,OLD.account_id,OLD.instance_id,OLD.policy_id) IS DISTINCT FROM (NEW.id,NEW.project_id,NEW.account_id,NEW.instance_id,NEW.policy_id)
      OR (OLD.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)) EXECUTE FUNCTION otp_router.reject_identity_change()`;
  yield* sql`CREATE TABLE otp_router.runtime_events (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id text UNIQUE NOT NULL, actor_id text NOT NULL,
    action text NOT NULL CHECK (action IN ('create','update','lifecycle','rotate','revoke-secret','invalidate','grant','revoke')),
    kind text NOT NULL CHECK (kind IN ('account','instance','policy','scope')), resource_id text NOT NULL,
    revision integer NOT NULL CHECK (revision > 0), project_id text REFERENCES otp_router.projects(id),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(kind,resource_id,revision)
  )`;
  yield* sql`CREATE INDEX runtime_event_resource ON otp_router.runtime_events(kind,resource_id,sequence)`;
});
