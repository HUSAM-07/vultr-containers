import sqlite3
import unittest
from pathlib import Path


class SchemaTest(unittest.TestCase):
    def test_tenant_and_spec_constraints(self):
        db = sqlite3.connect(":memory:")
        db.executescript(Path(__file__).with_name("0001_core.sql").read_text())
        db.execute("INSERT INTO users VALUES (1, 'owner', '', 1)")
        db.execute("INSERT INTO accounts VALUES ('a', 'Team', 1, 1)")
        db.execute("INSERT INTO account_memberships VALUES ('a', 1, 'owner')")
        db.execute("INSERT INTO projects VALUES ('p', 'a', 42, 'owner/repo', 8, 'main', 1)")
        db.execute("INSERT INTO specs VALUES ('s', 'p', 'specs/a.md', 'spec/a', 3, 'merged', 'abc', 1, 1)")
        db.execute("INSERT INTO runs VALUES ('r', 's', 'abc', 'model', 'provider', 'queued', NULL, NULL, NULL, 1, NULL)")
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO runs VALUES ('duplicate', 's', 'abc', 'model', 'provider', 'queued', NULL, NULL, NULL, 1, NULL)")
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO project_memberships VALUES ('p', 1, 'owner')")
        db.execute("INSERT INTO skills VALUES ('skill', 'a', NULL, 42, 'skills/review.md', 'abc', 1)")
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO skills VALUES ('duplicate', 'a', NULL, 42, 'skills/review.md', 'abc', 1)")


if __name__ == "__main__":
    unittest.main()
