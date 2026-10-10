CREATE TABLE run_mcp_grants (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
  PRIMARY KEY (run_id, grant_id)
);
