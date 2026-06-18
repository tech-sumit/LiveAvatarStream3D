-- LiveAvatarStream control-plane schema (D1 / SQLite).
-- No auth yet; `user_id` is a stable per-operator namespace.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  label       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS avatars (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT 'Untitled avatar',
  source_type TEXT NOT NULL,            -- reference_video | image_upload | generated
  status      TEXT NOT NULL,            -- pending | building | fine_tuning | ready | failed
  tier        TEXT NOT NULL DEFAULT 'premium',
  r2_prefix   TEXT NOT NULL,
  identity_dim INTEGER,
  has_lora    INTEGER NOT NULL DEFAULT 0,
  ref_duration_s REAL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avatars_user ON avatars(user_id);

CREATE TABLE IF NOT EXISTS voices (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT 'Untitled voice',
  status      TEXT NOT NULL,            -- pending | cloning | ready | failed
  engine      TEXT NOT NULL DEFAULT 'fish_s2',
  r2_prefix   TEXT NOT NULL,
  language    TEXT NOT NULL DEFAULT 'en',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voices_user ON voices(user_id);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- health_check | avatar_build | voice_clone | offline_render
  status      TEXT NOT NULL,            -- queued | running | tts | talking_head | finishing | succeeded | failed
  spec_json   TEXT NOT NULL,
  output_key  TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);

CREATE TABLE IF NOT EXISTS job_events (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT,
  progress    REAL,
  message     TEXT,
  data_json   TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, at);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  avatar_id   TEXT NOT NULL,
  voice_id    TEXT NOT NULL,
  status      TEXT NOT NULL,            -- allocating | connecting | live | ended | failed
  persona     TEXT,
  gpu_node    TEXT,
  started_at  INTEGER,
  ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
