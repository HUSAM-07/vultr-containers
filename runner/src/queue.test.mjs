import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dispatch, reconcile } from "./queue.ts";

const runId = "11111111-1111-4111-8111-111111111111";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_core.sql", "0002_spec_model.sql", "0003_run_output.sql", "0004_run_started_at.sql"])
    sqlite.exec(readFileSync(new URL(`../../infra/cloudflare/${file}`, import.meta.url), "utf8"));
  sqlite.exec("INSERT INTO users VALUES (1, 'owner', '', 1); INSERT INTO accounts VALUES ('a', 'owner', 1, 1); INSERT INTO projects VALUES ('p', 'a', 42, 'owner/private', 7, 'main', 1)");
  sqlite.prepare("INSERT INTO specs (id, project_id, path, branch, pull_number, status, merged_commit_sha, created_by, created_at, provider, model) VALUES (?, 'p', 'specs/change.md', 'spec/change', 4, 'merged', ?, 1, 1, 'openai', 'gpt-6-sol')")
    .run("s", "a".repeat(40));
  sqlite.prepare("INSERT INTO runs (id, spec_id, merged_commit_sha, model, provider, status, created_at) VALUES (?, 's', ?, 'gpt-6-sol', 'openai', 'queued', 1)")
    .run(runId, "a".repeat(40));
  const writes = new Map();
  const starts = [];
  let task = { state: "running" };
  let stopped = false;
  const sandbox = { async start(job) { starts.push(job); return "started"; },
    async status() { return task; }, async logs() { return { stdout: "agent events", stderr: "" }; },
    async diff() { return "diff --git a/a b/a\n+new code\n"; }, async stop() { stopped = true; } };
  const env = { DB: { prepare(sql) { let values = [];
    return { bind(...args) { values = args; return this; },
      async all() { return { results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
      async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; } }; } },
    SANDBOX: { getByName(id) { assert.equal(id, runId); return sandbox; } },
    ARTIFACTS: { async put(key, body) { writes.set(key, body); } },
    AI_GATEWAY_TOKEN: "gateway-token", GITHUB_APP_PRIVATE_KEY: "private-key", FAVA_RUN_SECRET: "s".repeat(40) };
  return { sqlite, env, starts, writes, setTask(value) { task = value; }, wasStopped() { return stopped; } };
}

test("only a merged spec claims a run, once, then stores its diff and logs", async () => {
  const { sqlite, env, starts, writes, setTask } = fixture();
  try {
    await dispatch(env);
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0], { id: runId, repository: "owner/private", repositoryId: 42,
      installationId: 7, sha: "a".repeat(40), specPath: "specs/change.md", provider: "openai", model: "gpt-6-sol" });
    await dispatch(env);
    assert.equal(starts.length, 1);
    setTask({ state: "succeeded", result: "Built requested change" });
    await reconcile(env);
    assert.deepEqual({ ...sqlite.prepare("SELECT status, summary, artifact_key AS artifactKey FROM runs WHERE id = ?").get(runId) },
      { status: "succeeded", summary: "Built requested change", artifactKey: `runs/${runId}` });
    assert.equal(writes.get(`runs/${runId}/diff.patch`).includes("new code"), true);
    assert.equal(writes.get(`runs/${runId}/stdout.log`), "agent events");
    assert.equal(writes.get(`runs/${runId}/stderr.log`), "");
  } finally { sqlite.close(); }
});

test("unmerged specs cannot dispatch even when a run row exists", async () => {
  const { sqlite, env, starts } = fixture();
  try {
    sqlite.exec("UPDATE specs SET status = 'open', merged_commit_sha = NULL");
    await dispatch(env);
    assert.deepEqual(starts, []);
    assert.equal(sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(runId).status, "queued");
  } finally { sqlite.close(); }
});

test("stale running jobs fail and their containers stop", async () => {
  const { sqlite, env, wasStopped } = fixture();
  try {
    sqlite.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?")
      .run(Date.now() - 46 * 60_000, runId);
    await reconcile(env);
    assert.equal(sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(runId).status, "failed");
    assert.equal(wasStopped(), true);
  } finally { sqlite.close(); }
});
