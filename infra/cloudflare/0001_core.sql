PRAGMA foreign_keys = ON;

CREATE TABLE users (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_github_id INTEGER NOT NULL REFERENCES users(github_id),
  created_at INTEGER NOT NULL
);

CREATE TABLE account_memberships (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  github_id INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  PRIMARY KEY (account_id, github_id)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_user ON sessions(github_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  github_repo_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  default_branch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, github_repo_id)
);
CREATE INDEX projects_account ON projects(account_id);

CREATE TABLE project_memberships (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  github_id INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  PRIMARY KEY (project_id, github_id)
);

CREATE TABLE specs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'merged', 'closed')),
  merged_commit_sha TEXT,
  created_by INTEGER NOT NULL REFERENCES users(github_id),
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, pull_number),
  UNIQUE (project_id, path)
);
CREATE INDEX specs_project_status ON specs(project_id, status);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  merged_commit_sha TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  implementation_branch TEXT,
  pull_number INTEGER,
  preview_url TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (spec_id, merged_commit_sha)
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  source_repo_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE UNIQUE INDEX skills_scope_source ON skills(account_id, COALESCE(project_id, ''), source_repo_id, path);

CREATE TABLE mcp_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_url TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,
  credential_ref TEXT,
  granted_by INTEGER NOT NULL REFERENCES users(github_id),
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX mcp_grants_project ON mcp_grants(project_id, revoked_at);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  target TEXT NOT NULL CHECK (target IN ('cloudflare', 'aws', 'gcp')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'deploying', 'ready', 'failed')),
  preview_url TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, target)
);

CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);
