import sqlite3
import unittest
from pathlib import Path


class SchemaTest(unittest.TestCase):
    def test_tenant_and_spec_constraints(self):
        db = sqlite3.connect(":memory:")
        db.executescript(Path(__file__).with_name("0001_core.sql").read_text())
        db.executescript(Path(__file__).with_name("0002_spec_model.sql").read_text())
        db.executescript(Path(__file__).with_name("0003_run_output.sql").read_text())
        db.executescript(Path(__file__).with_name("0004_run_started_at.sql").read_text())
        db.executescript(Path(__file__).with_name("0005_worker_previews.sql").read_text())
        db.execute("INSERT INTO users VALUES (1, 'owner', '', 1)")
        db.execute("INSERT INTO accounts VALUES ('a', 'Team', 1, 1)")
        db.execute("INSERT INTO account_memberships VALUES ('a', 1, 'owner')")
        db.execute("INSERT INTO projects VALUES ('p', 'a', 42, 'owner/repo', 8, 'main', 1)")
        db.execute("INSERT INTO specs (id, project_id, path, branch, pull_number, status, merged_commit_sha, created_by, created_at, provider, model) VALUES ('s', 'p', 'specs/a.md', 'spec/a', 3, 'merged', 'abc', 1, 1, 'openai', 'gpt-6-sol')")
        db.execute("INSERT INTO runs (id, spec_id, merged_commit_sha, model, provider, status, created_at) VALUES ('r', 's', 'abc', 'model', 'provider', 'queued', 1)")
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO runs (id, spec_id, merged_commit_sha, model, provider, status, created_at) VALUES ('duplicate', 's', 'abc', 'model', 'provider', 'queued', 1)")
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO project_memberships VALUES ('p', 1, 'owner')")
        db.execute("INSERT INTO skills VALUES ('skill', 'a', NULL, 42, 'skills/review.md', 'abc', 1)")
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO skills VALUES ('duplicate', 'a', NULL, 42, 'skills/review.md', 'abc', 1)")
        db.execute("INSERT INTO cloudflare_connections VALUES ('a', 'cloudflare', 'encrypted', 1)")
        db.execute("INSERT INTO cloudflare_project_previews VALUES ('p', 'a', 'worker', 'tag', 'trigger', 1)")
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO cloudflare_project_previews VALUES ('p', 'a', 'other', 'tag', 'trigger', 1)")


if __name__ == "__main__":
    unittest.main()
