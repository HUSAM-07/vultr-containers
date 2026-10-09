import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { dispatch, reconcile } from "./queue.ts";

const runId = "11111111-1111-4111-8111-111111111111";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_core.sql", "0002_spec_model.sql", "0003_run_output.sql", "0004_run_started_at.sql", "0006_run_skills.sql"])
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
    async diff() { return "diff --git a/a b/a\n+new code\n"; },
    async changes() { return [{ path: "a", mode: "100644", content: "bmV3IGNvZGU=" }]; },
    async stop() { stopped = true; } };
  const env = { DB: { prepare(sql) { let values = [];
    return { bind(...args) { values = args; return this; },
      async all() { return { results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
      async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; } }; } },
    SANDBOX: { getByName(id) { assert.equal(id, runId); return sandbox; } },
    ARTIFACTS: { async put(key, body) { writes.set(key, body); } },
    AI_GATEWAY_TOKEN: "gateway-token", GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }),
    FAVA_RUN_SECRET: "s".repeat(40) };
  return { sqlite, env, starts, writes, setTask(value) { task = value; }, wasStopped() { return stopped; } };
}

test("only a merged spec claims a run, once, then stores its diff and logs", async () => {
  const { sqlite, env, starts, writes, setTask } = fixture();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      if (path === "/app/installations/7/access_tokens") return Response.json({ token: "publisher" });
      if (path.endsWith(`/git/ref/heads/impl/${runId}`)) return new Response(null, { status: 404 });
      if (path.endsWith(`/git/commits/${"a".repeat(40)}`)) return Response.json({ tree: { sha: "b".repeat(40) } });
      if (path.endsWith("/git/blobs")) {
        assert.deepEqual(JSON.parse(options.body), { content: "bmV3IGNvZGU=", encoding: "base64" });
        return Response.json({ sha: "c".repeat(40) });
      }
      if (path.endsWith("/git/trees")) {
        assert.deepEqual(JSON.parse(options.body), { base_tree: "b".repeat(40),
          tree: [{ path: "a", mode: "100644", type: "blob", sha: "c".repeat(40) }] });
        return Response.json({ sha: "d".repeat(40) });
      }
      if (path.endsWith("/git/commits") && options.method === "POST") return Response.json({ sha: "e".repeat(40) });
      if (path.endsWith("/git/refs")) {
        assert.deepEqual(JSON.parse(options.body), { ref: `refs/heads/impl/${runId}`, sha: "e".repeat(40) });
        return Response.json({ object: { sha: "e".repeat(40) } });
      }
      if (path.endsWith("/pulls") && options.method === "GET") return Response.json([]);
      if (path.endsWith("/pulls") && options.method === "POST") {
        assert.deepEqual({ ...JSON.parse(options.body), body: undefined }, { title: "impl: spec #4",
          head: `impl/${runId}`, base: "main", draft: true, body: undefined });
        return Response.json({ number: 8, html_url: "https://github.com/owner/private/pull/8" });
      }
      throw Error(`Unexpected GitHub request ${url}`);
    };
    await dispatch(env);
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0], { id: runId, repository: "owner/private", repositoryId: 42,
      installationId: 7, sha: "a".repeat(40), specPath: "specs/change.md", provider: "openai", model: "gpt-6-sol", skills: "" });
    await dispatch(env);
    assert.equal(starts.length, 1);
    setTask({ state: "succeeded", result: "Built requested change" });
    await reconcile(env);
    assert.deepEqual({ ...sqlite.prepare("SELECT status, summary, artifact_key AS artifactKey, implementation_branch AS branch, pull_number AS pullNumber FROM runs WHERE id = ?").get(runId) },
      { status: "succeeded", summary: "Built requested change", artifactKey: `runs/${runId}`,
        branch: `impl/${runId}`, pullNumber: 8 });
    assert.equal(writes.get(`runs/${runId}/diff.patch`).includes("new code"), true);
    assert.equal(writes.get(`runs/${runId}/stdout.log`), "agent events");
    assert.equal(writes.get(`runs/${runId}/stderr.log`), "");
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
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

test("dispatch loads the skill version pinned when the spec merged", async () => {
  const { sqlite, env, starts } = fixture();
  const original = globalThis.fetch;
  try {
    sqlite.exec("INSERT INTO skills (id, account_id, project_id, source_repo_id, path, commit_sha, active) VALUES ('skill', 'a', NULL, 42, '.fava/skills/review.md', 'cccccccccccccccccccccccccccccccccccccccc', 1)");
    sqlite.prepare("INSERT INTO run_skills VALUES (?, 'skill', ?)").run(runId, "b".repeat(40));
    const content = "Review tests against the merged specification.";
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/access_tokens")) return Response.json({ token: "skill-token" });
      assert.equal(String(url), `https://api.github.com/repos/owner/private/contents/.fava/skills/review.md?ref=${"b".repeat(40)}`);
      return Response.json({ content: Buffer.from(content).toString("base64"), encoding: "base64", size: Buffer.byteLength(content) });
    };
    await dispatch(env);
    assert.match(starts[0].skills, /Review tests against the merged specification/);
    assert.match(starts[0].skills, new RegExp(`@${"b".repeat(40)}`));
  } finally { globalThis.fetch = original; sqlite.close(); }
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
