CREATE TABLE local_devices (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(github_id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX local_devices_project ON local_devices(project_id, revoked_at, expires_at);

CREATE TABLE local_device_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_github_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('paired', 'rotated', 'revoked')),
  created_at INTEGER NOT NULL
);
CREATE INDEX local_device_events_device ON local_device_events(device_id, created_at);
