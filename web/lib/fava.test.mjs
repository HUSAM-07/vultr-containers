import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { ensurePersonalAccount, linkProject, listProjects, listRuns, recordSpec } from "./fava-db.ts";
import { importContext, listRepositories, listSpecPullRequests, publishSpec, validateSpec, validSkillPath } from "./fava-github.ts";
import { readJson } from "./fava-json.ts";
import { chooseModel } from "./fava-models.ts";
import { seal, unseal } from "./fava-session.ts";
import { appJwt, processPullRequestEvent, verifyWebhookSignature } from "./fava-webhook.ts";

const spec = "## Outcome\n\nPeople can export their dashboard in one click.\n\n## Scope\n\nAdd a CSV download for the current filtered view.\n\n## Acceptance criteria\n\n- The CSV includes exactly the visible rows and columns.\n";

function testDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0001_core.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0002_spec_model.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0003_run_output.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0004_run_started_at.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0006_run_skills.sql", import.meta.url), "utf8"));
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
  return { sqlite, db };
}

test("spec validation rejects template guidance", () => {
  assert.throws(() => chooseModel("arbitrary-model"), /supported agent model/);
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

test("skill paths are constrained to versioned repository Markdown files", () => {
  assert.equal(validSkillPath(".fava/skills/review.md"), true);
  assert.equal(validSkillPath(".fava/skills/../secrets.md"), false);
  assert.equal(validSkillPath("specs/review.md"), false);
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
  const { sqlite, db } = testDb();
  try {
    const account = await ensurePersonalAccount(db, { id: 1, login: "owner", avatarUrl: "" });
    const repo = { id: 42, fullName: "owner/repo", installationId: 7, defaultBranch: "main" };
    const first = await linkProject(db, account, repo);
    const second = await linkProject(db, account, repo);
    assert.equal(first.id, second.id);
    assert.deepEqual(await listProjects(db, account), [{ id: first.id, repository: "owner/repo", defaultBranch: "main" }]);
    assert.deepEqual(await listProjects(db, "github:2"), []);
    await recordSpec(db, first.id, 1, { number: 4, path: "specs/export-123.md", branch: "spec/export-123" },
      chooseModel("gpt-6-sol"));
    assert.deepEqual({ ...sqlite.prepare("SELECT status, provider, model FROM specs WHERE project_id = ? AND pull_number = 4").get(first.id) },
      { status: "open", provider: "openai", model: "gpt-6-sol" });
    await ensurePersonalAccount(db, { id: 1, login: "renamed", avatarUrl: "" });
    assert.equal(sqlite.prepare("SELECT login FROM users WHERE github_id = 1").get().login, "renamed");
  } finally { sqlite.close(); }
});

test("signed merge webhook records only a tracked spec-only PR", async () => {
  const { sqlite, db } = testDb();
  const original = globalThis.fetch;
  try {
    const account = await ensurePersonalAccount(db, { id: 1, login: "owner", avatarUrl: "" });
    const project = await linkProject(db, account, { id: 42, fullName: "owner/repo", installationId: 7, defaultBranch: "main" });
    sqlite.prepare("INSERT INTO skills (id, account_id, project_id, source_repo_id, path, commit_sha, active) VALUES ('skill-1', ?, NULL, 42, '.fava/skills/review.md', ?, 1)")
      .run(account, "b".repeat(40));
    const specId = await recordSpec(db, project.id, 1,
      { number: 4, path: "specs/export-123.md", branch: "spec/export-123" }, chooseModel("gpt-6-sol"));
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" });
    const jwt = appJwt("Iv1.test", pem);
    const [header, claims, signature] = jwt.split(".");
    assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey,
      Buffer.from(signature, "base64url")), true);
    assert.equal(JSON.parse(Buffer.from(claims, "base64url").toString()).iss, "Iv1.test");
    const event = { action: "closed", installation: { id: 7 }, repository: { id: 42, full_name: "owner/repo" },
      pull_request: { number: 4, merged: true, merge_commit_sha: "a".repeat(40),
        head: { ref: "spec/export-123" }, base: { ref: "main" } } };
    const raw = Buffer.from(JSON.stringify(event));
    const digest = `sha256=${createHmac("sha256", "webhook-secret").update(raw).digest("hex")}`;
    assert.equal(verifyWebhookSignature("webhook-secret", raw, digest), true);
    assert.equal(verifyWebhookSignature("webhook-secret", Buffer.from("tampered"), digest), false);
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
      if (String(url).endsWith("/pulls/4/files?per_page=100"))
        return Response.json([{ filename: "specs/export-123.md", status: "added" }]);
      if (String(url).includes("/contents/specs/export-123.md?ref="))
        return Response.json({ content: Buffer.from(`# Export dashboard\n\n${spec}`).toString("base64"),
          encoding: "base64", size: Buffer.byteLength(`# Export dashboard\n\n${spec}`) });
      if (String(url).endsWith("/pulls/5/files?per_page=100"))
        return Response.json([{ filename: "specs/unsafe-123.md", status: "added" }, { filename: "src/extra.ts", status: "added" }]);
      if (String(url).endsWith("/pulls/6/files?per_page=100"))
        return Response.json([{ filename: "specs/invalid-123.md", status: "added" }]);
      if (String(url).includes("/contents/specs/invalid-123.md?ref="))
        return Response.json({ content: Buffer.from("# Invalid spec\n\nNo acceptance criteria").toString("base64"),
          encoding: "base64", size: 39 });
      throw Error("Unexpected GitHub request");
    };
    const recorded = await processPullRequestEvent(db, event, "delivery-1",
      { clientId: "Iv1.test", privateKey: pem });
    assert.deepEqual(recorded, { recorded: true, status: "merged", specIds: [specId] });
    assert.deepEqual(requests.map(request => request.url), [
      "https://api.github.com/app/installations/7/access_tokens",
      "https://api.github.com/repos/owner/repo/pulls/4/files?per_page=100",
      `https://api.github.com/repos/owner/repo/contents/specs/export-123.md?ref=${"a".repeat(40)}`,
    ]);
    assert.deepEqual(JSON.parse(requests[0].init.body).repository_ids, [42]);
    assert.equal(sqlite.prepare("SELECT status FROM specs WHERE id = ?").get(specId).status, "merged");
    assert.deepEqual({ ...sqlite.prepare("SELECT spec_id AS specId, merged_commit_sha AS sha, model, provider, status FROM runs WHERE spec_id = ?").get(specId) },
      { specId, sha: "a".repeat(40), model: "gpt-6-sol", provider: "openai", status: "queued" });
    assert.equal(sqlite.prepare("SELECT commit_sha AS sha FROM run_skills").get().sha, "b".repeat(40));
    assert.equal((await listRuns(db, account, "owner/repo")).length, 1);
    assert.deepEqual(await listRuns(db, "github:2", "owner/repo"), []);
    assert.equal(sqlite.prepare("SELECT processed_at FROM webhook_deliveries WHERE delivery_id = 'delivery-1'").get().processed_at > 0, true);
    assert.deepEqual(await processPullRequestEvent(db, event, "delivery-1",
      { clientId: "Iv1.test", privateKey: pem }), { recorded: true, duplicate: true });
    assert.equal(requests.length, 3);
    sqlite.exec(`UPDATE skills SET commit_sha = '${"c".repeat(40)}' WHERE id = 'skill-1'`);
    assert.deepEqual(await processPullRequestEvent(db, event, "delivery-1-redelivery",
      { clientId: "Iv1.test", privateKey: pem }), { recorded: true, status: "merged", specIds: [specId] });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM runs WHERE spec_id = ?").get(specId).count, 1);
    assert.equal(sqlite.prepare("SELECT commit_sha AS sha FROM run_skills").get().sha, "b".repeat(40));
    await recordSpec(db, project.id, 1,
      { number: 5, path: "specs/unsafe-123.md", branch: "spec/unsafe-123" }, chooseModel("claude-sonnet-5"));
    await assert.rejects(processPullRequestEvent(db, { ...event,
      pull_request: { ...event.pull_request, number: 5, head: { ref: "spec/unsafe-123" } } },
    "delivery-2", { clientId: "Iv1.test", privateKey: pem }), error => error.status === 422);
    assert.equal(sqlite.prepare("SELECT status FROM specs WHERE pull_number = 5").get().status, "open");
    await recordSpec(db, project.id, 1,
      { number: 6, path: "specs/invalid-123.md", branch: "spec/invalid-123" }, chooseModel("gpt-6-sol"));
    await assert.rejects(processPullRequestEvent(db, { ...event,
      pull_request: { ...event.pull_request, number: 6, head: { ref: "spec/invalid-123" } } },
    "delivery-3", { clientId: "Iv1.test", privateKey: pem }), error => error.status === 422);
    assert.equal(sqlite.prepare("SELECT status FROM specs WHERE pull_number = 6").get().status, "open");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM runs").get().count, 1);
  } finally { globalThis.fetch = original; sqlite.close(); }
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
    [{ filename: "specs/export-123.md", status: "added" }],
    [{ filename: "specs/unsafe-123.md", status: "added" }, { filename: "src/extra.ts", status: "added" }],
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
