ALTER TABLE runs ADD COLUMN local_submission_key TEXT;
ALTER TABLE runs ADD COLUMN local_submission_sha256 TEXT;
ALTER TABLE runs ADD COLUMN local_submitted_at INTEGER;
CREATE INDEX runs_local_submitted ON runs(execution_mode, local_submitted_at, status);
