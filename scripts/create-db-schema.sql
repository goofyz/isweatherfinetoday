CREATE EXTENSION IF NOT EXISTS plpgsql;

CREATE TABLE IF NOT EXISTS api_requests (
  id bigserial PRIMARY KEY,
  version varchar,
  lat varchar,
  lng varchar,
  ip varchar,
  photo_id varchar,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL,
  request_time timestamp,
  width varchar,
  height varchar,
  density varchar,
  lang varchar,
  station_code varchar,
  operator varchar
);

CREATE TABLE IF NOT EXISTS aqhi_stations (
  id bigserial PRIMARY KEY,
  code varchar,
  chi_name varchar,
  eng_name varchar,
  lat numeric(10,6),
  lng numeric(10,6),
  station_type varchar,
  aqhi_index varchar,
  update_time timestamp,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS index_aqhi_stations_on_code ON aqhi_stations (code);

CREATE TABLE IF NOT EXISTS devices (
  id bigserial PRIMARY KEY,
  reg_id text NOT NULL,
  os_type varchar,
  app_version integer,
  lang varchar,
  ip_address varchar,
  status varchar,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS index_devices_on_reg_id ON devices (reg_id);

DELETE FROM devices WHERE reg_id IS NULL;
ALTER TABLE devices ALTER COLUMN reg_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS flickr_photos (
  id bigserial PRIMARY KEY,
  photo_id varchar,
  owner_name varchar,
  owner_url varchar,
  mid_res_url varchar,
  high_res_url varchar,
  tags text[],
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL
);

CREATE TABLE IF NOT EXISTS forecasts (
  id bigserial PRIMARY KEY,
  forecast_day date,
  weather varchar,
  max_temperature varchar,
  min_temperature varchar,
  max_humidity varchar,
  min_humidity varchar,
  chi_detail varchar,
  eng_detail varchar,
  chi_wind varchar,
  eng_wind varchar,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL,
  psr integer
);
CREATE UNIQUE INDEX IF NOT EXISTS index_forecasts_on_forecast_day ON forecasts (forecast_day);

CREATE TABLE IF NOT EXISTS gcm_notifications (
  id bigserial PRIMARY KEY,
  reg_ids text,
  op varchar,
  content text,
  collapse_key varchar,
  target_sent_time timestamp,
  sent_time timestamp,
  response text,
  message_id varchar,
  sent_count integer,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS index_gcm_notifications_on_target_sent_time ON gcm_notifications (target_sent_time);

CREATE TABLE IF NOT EXISTS heat_indices (
  id bigserial PRIMARY KEY,
  eng_title text,
  chi_title text,
  eng_content text,
  chi_content text,
  warning_type varchar,
  time timestamp,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL
);

CREATE TABLE IF NOT EXISTS hour_forecasts (
  id bigserial PRIMARY KEY,
  code varchar,
  data jsonb,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS index_code ON hour_forecasts (code);

CREATE TABLE IF NOT EXISTS special_weather_tips (
  id bigserial PRIMARY KEY,
  eng_title text,
  chi_title text,
  eng_content text,
  chi_content text,
  time timestamp,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL
);

CREATE TABLE IF NOT EXISTS station_data (
  id bigserial PRIMARY KEY,
  weather_station_id bigint,
  wind_direction integer,
  wind_speed integer,
  temperature numeric(3,1),
  humidity integer,
  max_temp numeric(3,1),
  min_temp numeric(3,1),
  update_time varchar,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS index_station_data_on_weather_station_id ON station_data (weather_station_id);

CREATE TABLE IF NOT EXISTS todays (
  id bigserial PRIMARY KEY,
  forecast_day date,
  weather varchar,
  temperature varchar,
  humidity varchar,
  uv varchar,
  location varchar,
  chi_detail text,
  warning varchar,
  update_time varchar,
  uv_level varchar,
  sun_rise_time varchar,
  sun_set_time varchar,
  moon_rise_time varchar,
  moon_set_time varchar,
  eng_detail text,
  typhoon_id varchar,
  aqhi_current varchar,
  chi_aqhi_forecast varchar,
  eng_aqhi_forecast varchar,
  aqhi_update_time timestamp,
  tide_info varchar,
  astronomical_update_time timestamp,
  chi_forecast_general text,
  eng_forecast_general text,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS index_todays_on_forecast_day ON todays (forecast_day);

CREATE TABLE IF NOT EXISTS typhoons (
  id bigserial PRIMARY KEY,
  typhoon_type varchar,
  eng_name varchar,
  chi_name varchar,
  hko_id integer,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL,
  data_type varchar
);
CREATE UNIQUE INDEX IF NOT EXISTS index_typhoons_on_hko_id ON typhoons (hko_id);

CREATE TABLE IF NOT EXISTS weather_stations (
  id bigserial PRIMARY KEY,
  code varchar,
  chi_name varchar,
  lat numeric(10,6),
  lng numeric(10,6),
  wind_lat numeric(10,6),
  wind_lng numeric(10,6),
  webcam_angle integer,
  eng_name varchar,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL,
  chi_name_abbr varchar,
  eng_name_abbr varchar,
  station_operator varchar,
  photo_code varchar,
  is_forecast boolean
);
CREATE UNIQUE INDEX IF NOT EXISTS index_weather_stations_on_code ON weather_stations (code);

CREATE TABLE IF NOT EXISTS weather_warnings (
  id bigserial PRIMARY KEY,
  warning_type varchar,
  time timestamp,
  eng_detail text,
  chi_detail text,
  created_at timestamp(6) NOT NULL,
  updated_at timestamp(6) NOT NULL
);
