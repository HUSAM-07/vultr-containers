ALTER TABLE specs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'cloud' CHECK (execution_mode IN ('cloud', 'local'));
ALTER TABLE runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'cloud' CHECK (execution_mode IN ('cloud', 'local'));
ALTER TABLE runs ADD COLUMN lease_id TEXT;
ALTER TABLE runs ADD COLUMN lease_device_id TEXT REFERENCES local_devices(id);
ALTER TABLE runs ADD COLUMN lease_expires_at INTEGER;
CREATE INDEX runs_local_claim ON runs(execution_mode, status, created_at);

CREATE VIEW eligible_local_devices AS
SELECT local_devices.* FROM local_devices JOIN projects ON projects.id = local_devices.project_id
WHERE EXISTS (SELECT 1 FROM account_memberships WHERE account_id = projects.account_id
  AND github_id = local_devices.created_by AND role IN ('owner', 'admin'))
   OR EXISTS (SELECT 1 FROM project_memberships WHERE project_id = projects.id
  AND github_id = local_devices.created_by AND role = 'admin');
