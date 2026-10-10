CREATE TABLE cloudflare_connections (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  cloudflare_account_id TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  connected_at INTEGER NOT NULL
);

CREATE TABLE cloudflare_project_previews (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES cloudflare_connections(account_id) ON DELETE CASCADE,
  worker_name TEXT NOT NULL,
  worker_tag TEXT NOT NULL,
  trigger_uuid TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
