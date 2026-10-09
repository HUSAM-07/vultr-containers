import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChanges } from "./changes.ts";

const sha = "a".repeat(40);
const raw = (oldMode, mode, status, path) =>
  `:${oldMode} ${mode} ${"0".repeat(40)} ${sha} ${status}\0${path}\0`;

test("Git change manifest accepts regular edits and deletes without renames", () => {
  assert.deepEqual(parseChanges(raw("000000", "100644", "A", "src/a.ts") +
    raw("100644", "000000", "D", "old.ts")), [
    { path: "src/a.ts", mode: "100644", sha },
    { path: "old.ts", mode: "100644", sha: null },
  ]);
});

test("Git change manifest rejects protected and unsupported files", () => {
  for (const path of ["specs/goal.md", ".fava/skills/trust.md", "AGENTS.md", "src/CLAUDE.md", "../escape", "a/../b"])
    assert.throws(() => parseChanges(raw("000000", "100644", "A", path)), /protected or invalid/);
  assert.throws(() => parseChanges(raw("100644", "120000", "M", "link")), /Unsupported Git file mode/);
  assert.throws(() => parseChanges(""), /between 1 and 25/);
});

test("parser accepts Git's actual staged raw output", () => {
  const directory = mkdtempSync(join(tmpdir(), "fava-changes-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  try {
    git("init", "--quiet");
    writeFileSync(join(directory, "old.ts"), "before\n");
    git("add", "--all");
    git("-c", "user.name=Fava", "-c", "user.email=fava@example.invalid", "commit", "--quiet", "-m", "base");
    unlinkSync(join(directory, "old.ts"));
    writeFileSync(join(directory, "new.ts"), "after\n");
    git("add", "--all");
    assert.deepEqual(parseChanges(git("diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z", "HEAD"))
      .map(({ path, mode, sha }) => ({ path, mode, exists: sha !== null })), [
      { path: "new.ts", mode: "100644", exists: true },
      { path: "old.ts", mode: "100644", exists: false },
    ]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
