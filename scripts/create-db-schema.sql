CREATE EXTENSION IF NOT EXISTS plpgsql;


CREATE TABLE IF NOT EXISTS devices (
  id bigserial PRIMARY KEY,
  reg_id text NOT NULL,
  os_type varchar,
  app_version integer,
  lang varchar,
  ip_address varchar,
  status varchar,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS index_devices_on_reg_id ON devices (reg_id);

DELETE FROM devices WHERE reg_id IS NULL;
ALTER TABLE devices ALTER COLUMN reg_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS gcm_notifications (
  id bigserial PRIMARY KEY,
  reg_ids text,
  op varchar,
  content text,
  collapse_key varchar,
  target_sent_time timestamptz,
  sent_time timestamptz,
  response text,
  message_id varchar,
  sent_count integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS index_gcm_notifications_on_target_sent_time ON gcm_notifications (target_sent_time);
