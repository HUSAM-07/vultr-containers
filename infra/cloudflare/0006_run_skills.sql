CREATE TABLE run_skills (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  commit_sha TEXT NOT NULL,
  PRIMARY KEY (run_id, skill_id)
);
CREATE INDEX run_skills_run ON run_skills(run_id);
