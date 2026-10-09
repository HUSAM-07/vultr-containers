import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalAccount, linkProject, listProjects } from "./fava-db.ts";
import { importContext, listRepositories, listSpecPullRequests, publishSpec, validateSpec } from "./fava-github.ts";
import { readJson } from "./fava-json.ts";
import { seal, unseal } from "./fava-session.ts";

const spec = "## Outcome\n\nPeople can export their dashboard in one click.\n\n## Scope\n\nAdd a CSV download for the current filtered view.\n\n## Acceptance criteria\n\n- The CSV includes exactly the visible rows and columns.\n";

test("spec validation rejects template guidance", () => {
  assert.throws(() => validateSpec("Export dashboard", "## Outcome\n\nDescribe the result a user should experience.\n\n## Scope\n\nDescribe what must be built, and what is outside this change.\n\n## Acceptance criteria\n\n- Describe an observable behavior or test."), /Replace the template/);
  assert.equal(validateSpec("Export dashboard", spec).title, "Export dashboard");
});

test("publishing a spec creates a branch, file, and PR in that order", async () => {
  const original = globalThis.fetch;
  const requests = [];
  const replies = [
    { default_branch: "main", permissions: { push: true } },
    { commit: { sha: "abc123" } },
    { ref: "created" },
    { content: { path: "specs/export-dashboard-unique.md" } },
    { html_url: "https://github.com/owner/repo/pull/4", number: 4 },
  ];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return Response.json(replies.shift());
  };
  try {
    const result = await publishSpec("test-token", "owner/repo", "Export dashboard", spec + "\nRésumé: ✓\n");
    assert.equal(result.url, "https://github.com/owner/repo/pull/4");
    assert.deepEqual(requests.map(item => item.method), ["GET", "GET", "POST", "PUT", "POST"]);
    assert.match(requests[2].body.ref, /^refs\/heads\/spec\/export-dashboard-/);
    assert.match(requests[3].url, /^https:\/\/api\.github\.com\/repos\/owner\/repo\/contents\/specs\/export-dashboard-[a-f0-9]{8}\.md$/);
    assert.match(Buffer.from(requests[3].body.content, "base64").toString(), /Résumé: ✓/);
    assert.equal(requests[4].body.base, "main");
  } finally { globalThis.fetch = original; }
});

test("context import reads repository instructions and a bounded file map", async () => {
  const original = globalThis.fetch;
  const requests = [];
  const replies = [
    { default_branch: "main" },
    { tree: [{ path: "README.md", type: "blob" }, { path: "AGENTS.md", type: "blob" },
      { path: ".fava/skills/review.md", type: "blob" }], truncated: false },
    { content: Buffer.from("Project overview").toString("base64"), encoding: "base64", size: 16 },
    { content: Buffer.from("Project rules").toString("base64"), encoding: "base64", size: 13 },
  ];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return Response.json(replies.shift());
  };
  try {
    const context = await importContext("test-token", "owner/repo");
    assert.deepEqual(context.paths, ["README.md", "AGENTS.md", ".fava/skills/review.md"]);
    assert.deepEqual(context.files.map(file => file.path), ["README.md", "AGENTS.md"]);
    assert.equal(requests.length, 4);
  } finally { globalThis.fetch = original; }
});

test("repository listing retains the installation needed to link a project", async () => {
  const original = globalThis.fetch;
  const replies = [
    { installations: [{ id: 7 }] },
    { repositories: [{ id: 42, full_name: "owner/repo", private: true, default_branch: "main",
      html_url: "https://github.com/owner/repo", permissions: { push: true } }] },
  ];
  globalThis.fetch = async () => Response.json(replies.shift());
  try {
    assert.equal((await listRepositories("test-token"))[0].installationId, 7);
  } finally { globalThis.fetch = original; }
});

test("JSON reader rejects malformed and streamed oversized bodies", async () => {
  await assert.rejects(readJson(new Request("http://localhost", { method: "POST", body: "{" }), 1000),
    error => error.status === 400);
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(1001)); controller.close();
  } });
  await assert.rejects(readJson(new Request("http://localhost", { method: "POST", body, duplex: "half" }), 1000),
    error => error.status === 413);
});

test("GitHub identity creates one personal account and links a repository once", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0001_core.sql", import.meta.url), "utf8"));
  const db = {
    prepare(sql) {
      let values = [];
      return { bind(...params) { values = params; return this; },
        async run() { sqlite.prepare(sql).run(...values); },
        async first() { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
        async all() { return { results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
        execute() { sqlite.prepare(sql).run(...values); } };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { for (const statement of statements) statement.execute(); sqlite.exec("COMMIT"); }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  try {
    const account = await ensurePersonalAccount(db, { id: 1, login: "owner", avatarUrl: "" });
    const repo = { id: 42, fullName: "owner/repo", installationId: 7, defaultBranch: "main" };
    const first = await linkProject(db, account, repo);
    const second = await linkProject(db, account, repo);
    assert.equal(first.id, second.id);
    assert.deepEqual(await listProjects(db, account), [{ id: first.id, repository: "owner/repo", defaultBranch: "main" }]);
    assert.deepEqual(await listProjects(db, "github:2"), []);
    await ensurePersonalAccount(db, { id: 1, login: "renamed", avatarUrl: "" });
    assert.equal(sqlite.prepare("SELECT login FROM users WHERE github_id = 1").get().login, "renamed");
  } finally { sqlite.close(); }
});

test("spec pipeline includes only single-file proposals to the default branch", async () => {
  const original = globalThis.fetch;
  const replies = [
    { default_branch: "main" },
    [
      { number: 4, title: "spec: Export", html_url: "https://github.com/owner/repo/pull/4", state: "closed",
        merged_at: "2026-10-09T00:00:00Z", merge_commit_sha: "merged-sha", head: { ref: "spec/export-123" }, base: { ref: "main" } },
      { number: 5, title: "spec: Unsafe", html_url: "https://github.com/owner/repo/pull/5", state: "open",
        merged_at: null, merge_commit_sha: null, head: { ref: "spec/unsafe-123" }, base: { ref: "main" } },
      { number: 6, title: "Other branch", head: { ref: "feature/other" }, base: { ref: "main" } },
    ],
    [{ filename: "specs/export-123.md" }],
    [{ filename: "specs/unsafe-123.md" }, { filename: "src/extra.ts" }],
  ];
  globalThis.fetch = async () => Response.json(replies.shift());
  try {
    const proposals = await listSpecPullRequests("test-token", "owner/repo");
    assert.equal(proposals.length, 1);
    assert.deepEqual(proposals[0], { number: 4, title: "spec: Export",
      url: "https://github.com/owner/repo/pull/4", path: "specs/export-123.md",
      status: "merged", mergedCommitSha: "merged-sha" });
  } finally { globalThis.fetch = original; }
});

test("session cookie is encrypted and rejects tampering", async () => {
  process.env.FAVA_SESSION_SECRET = "test-secret-that-is-at-least-32-characters-long";
  const session = { token: "sensitive-token", expiresAt: Date.now() + 1000,
    user: { id: 1, login: "test", avatarUrl: "" } };
  const cookie = await seal(session);
  assert.equal(cookie.includes(session.token), false);
  assert.deepEqual(await unseal(cookie), session);
  assert.equal(await unseal((cookie.startsWith("A") ? "B" : "A") + cookie.slice(1)), null);
});
