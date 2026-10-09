import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { accountAccess, createAccount, ensurePersonalAccount, linkProject, listAccountMembers,
  listAccounts, listProjectMembers, listProjects, listRuns, projectAccess, recordSpec,
  removeAccountMember, removeProjectMember, setAccountMember, setProjectMember } from "./fava-db.ts";
import { encryptToken } from "./fava-cloudflare.ts";
import { refreshRunPreviews } from "./fava-run-previews.ts";
import { importContext, listRepositories, listSpecPullRequests, publishSpec, validateSpec, validSkillPath } from "./fava-github.ts";
import { readJson } from "./fava-json.ts";
import { chooseModel } from "./fava-models.ts";
import { createSession, readSession, revokeSession, seal, unseal } from "./fava-session.ts";
import { appJwt, processAuthorizationRevocation, processInstallationLoss, processPullRequestEvent, verifyWebhookSignature } from "./fava-webhook.ts";

const spec = "## Outcome\n\nPeople can export their dashboard in one click.\n\n## Scope\n\nAdd a CSV download for the current filtered view.\n\n## Acceptance criteria\n\n- The CSV includes exactly the visible rows and columns.\n";

function testDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0001_core.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0002_spec_model.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0003_run_output.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0004_run_started_at.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0005_worker_previews.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0006_run_skills.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0007_unique_project_repository.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0008_run_mcp_grants.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../infra/cloudflare/0009_implementation_sha.sql", import.meta.url), "utf8"));
  const db = {
    prepare(sql) {
      let values = [];
      return { bind(...params) { values = params; return this; },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
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
  const commitSha = "a".repeat(40);
  const replies = [
    { default_branch: "main" },
    { commit: { sha: commitSha } },
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
    assert.equal(context.commitSha, commitSha);
    assert.equal(requests[1], "https://api.github.com/repos/owner/repo/branches/main");
    assert.equal(requests[2], `https://api.github.com/repos/owner/repo/git/trees/${commitSha}?recursive=1`);
    assert.equal(requests[3], `https://api.github.com/repos/owner/repo/contents/README.md?ref=${commitSha}`);
    assert.equal(requests[4], `https://api.github.com/repos/owner/repo/contents/AGENTS.md?ref=${commitSha}`);
  } finally { globalThis.fetch = original; }
});

test("context import stops when GitHub does not return a commit SHA", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => Response.json(++calls === 1
    ? { default_branch: "main" } : { commit: { sha: "invalid" } });
  try {
    await assert.rejects(importContext("test-token", "owner/repo"), /invalid branch commit/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("repository listing includes later installation pages", async () => {
  const original = globalThis.fetch;
  const repository = id => ({ id, full_name: `owner/repo-${id}`, private: true,
    default_branch: "main", html_url: `https://github.com/owner/repo-${id}`, permissions: { push: true } });
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.endsWith("/user/installations?per_page=100"))
      return Response.json({ total_count: 1, installations: [{ id: 7 }] });
    if (path.endsWith("/repositories?per_page=100"))
      return Response.json({ total_count: 101, repositories: Array.from({ length: 100 }, (_, i) => repository(i + 1)) });
    assert.equal(path.endsWith("/repositories?per_page=100&page=2"), true);
    return Response.json({ total_count: 101, repositories: [repository(101)] });
  };
  try {
    const listed = await listRepositories("test-token");
    assert.equal(listed.length, 101);
    assert.equal(listed.find(item => item.id === 101)?.installationId, 7);
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
    assert.deepEqual(await listProjects(db, 1, [repo]), [{ id: first.id, accountId: account,
      accountName: "owner's workspace", repository: "owner/repo", defaultBranch: "main", role: "owner", accountRole: "owner" }]);
    assert.deepEqual(await listProjects(db, 2, [repo]), []);
    await ensurePersonalAccount(db, { id: 2, login: "member", avatarUrl: "" });
    await assert.rejects(linkProject(db, "github:2", repo), /already belongs/);
    await recordSpec(db, first.id, 1, { number: 4, path: "specs/export-123.md", branch: "spec/export-123" },
      chooseModel("gpt-6-sol"));
    assert.deepEqual({ ...sqlite.prepare("SELECT status, provider, model FROM specs WHERE project_id = ? AND pull_number = 4").get(first.id) },
      { status: "open", provider: "openai", model: "gpt-6-sol" });
    await ensurePersonalAccount(db, { id: 1, login: "renamed", avatarUrl: "" });
    assert.equal(sqlite.prepare("SELECT login FROM users WHERE github_id = 1").get().login, "renamed");
  } finally { sqlite.close(); }
});

test("project membership grants only its role and still requires the same GitHub repository", async () => {
  const { sqlite, db } = testDb();
  const original = globalThis.fetch;
  const oldClientId = process.env.GITHUB_APP_CLIENT_ID;
  const oldPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GITHUB_APP_CLIENT_ID = "Iv1.test";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs1", format: "pem" });
  try {
    const account = await ensurePersonalAccount(db, { id: 1, login: "owner", avatarUrl: "" });
    await ensurePersonalAccount(db, { id: 2, login: "member", avatarUrl: "" });
    const repo = { id: 42, fullName: "owner/repo", installationId: 7, defaultBranch: "main" };
    const project = await linkProject(db, account, repo);
    sqlite.prepare("INSERT INTO project_memberships (project_id, github_id, role) VALUES (?, 2, 'viewer')").run(project.id);
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/installation")) {
        assert.match(init.headers.Authorization, /^Bearer eyJ/);
        return Response.json({ id: 7 });
      }
      assert.equal(init.headers.Authorization, "Bearer member-token");
      return Response.json({ id: 42 });
    };
    assert.deepEqual(await listProjects(db, 2, [repo]), [{ id: project.id, accountId: account,
      accountName: "owner's workspace", repository: repo.fullName,
      defaultBranch: "main", role: "viewer", accountRole: null }]);
    assert.deepEqual(await listProjects(db, 2, [{ ...repo, installationId: 8 }]), []);
    assert.equal((await projectAccess(db, 2, repo.fullName, "member-token")).id, project.id);
    await assert.rejects(projectAccess(db, 2, repo.fullName, "member-token", "editor"), /do not have access/);
    sqlite.prepare("UPDATE project_memberships SET role = 'editor' WHERE project_id = ? AND github_id = 2").run(project.id);
    assert.equal((await projectAccess(db, 2, repo.fullName, "member-token", "editor")).role, "editor");
    globalThis.fetch = async url => Response.json({ id: String(url).endsWith("/installation") ? 8 : 42 });
    await assert.rejects(projectAccess(db, 2, repo.fullName, "member-token"), /no longer has access/);
    globalThis.fetch = async url => Response.json({ id: String(url).endsWith("/installation") ? 7 : 43 });
    await assert.rejects(projectAccess(db, 2, repo.fullName, "member-token"), /identity changed/);
  } finally {
    globalThis.fetch = original;
    if (oldClientId === undefined) delete process.env.GITHUB_APP_CLIENT_ID;
    else process.env.GITHUB_APP_CLIENT_ID = oldClientId;
    if (oldPrivateKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
    else process.env.GITHUB_APP_PRIVATE_KEY = oldPrivateKey;
    sqlite.close();
  }
});

test("project administrators can add GitHub users before sign-in", async () => {
  const { sqlite, db } = testDb();
  const original = globalThis.fetch;
  try {
    const account = await ensurePersonalAccount(db, { id: 1, login: "owner", avatarUrl: "" });
    await ensurePersonalAccount(db, { id: 2, login: "member", avatarUrl: "" });
    const repo = { id: 42, fullName: "owner/repo", installationId: 7, defaultBranch: "main" };
    const project = await linkProject(db, account, repo);
    globalThis.fetch = async url => Response.json(String(url).endsWith("/unknown")
      ? { id: 999, login: "unknown" } : { id: 2, login: "member" });
    assert.equal(await setProjectMember(db, project.id, "test-token", "unknown", "viewer"), 999);
    assert.deepEqual(await listProjectMembers(db, project.id),
      [{ githubId: 999, login: "unknown", role: "viewer", signedIn: 0 }]);
    await ensurePersonalAccount(db, { id: 999, login: "renamed", avatarUrl: "" });
    assert.deepEqual((await listProjectMembers(db, project.id)).find(member => member.githubId === 999),
      { githubId: 999, login: "renamed", role: "viewer", signedIn: 1 });
    assert.equal((await listProjects(db, 999, [repo]))[0].id, project.id);
    assert.equal(await setProjectMember(db, project.id, "test-token", "MEMBER", "viewer"), 2);
    assert.equal((await listProjectMembers(db, project.id)).find(member => member.githubId === 2)?.signedIn, 1);
    await setProjectMember(db, project.id, "test-token", "member", "editor");
    assert.equal((await listProjectMembers(db, project.id)).find(member => member.githubId === 2)?.role, "editor");
    await removeProjectMember(db, project.id, 2);
    await removeProjectMember(db, project.id, 999);
    assert.deepEqual(await listProjectMembers(db, project.id), []);
  } finally { globalThis.fetch = original; sqlite.close(); }
});

test("team workspace roles control access and protect its owner", async () => {
  const { sqlite, db } = testDb();
  const original = globalThis.fetch;
  try {
    await ensurePersonalAccount(db, { id: 1, login: "owner", avatarUrl: "" });
    await ensurePersonalAccount(db, { id: 2, login: "member", avatarUrl: "" });
    const team = await createAccount(db, 1, "Product team");
    assert.equal((await listAccounts(db, 1)).find(item => item.id === team.id)?.role, "owner");
    await assert.rejects(accountAccess(db, 2, team.id), /do not have access/);
    globalThis.fetch = async url => Response.json(String(url).endsWith("/owner")
      ? { id: 1, login: "owner" } : String(url).endsWith("/newbie")
        ? { id: 3, login: "newbie" } : { id: 2, login: "member" });
    await setAccountMember(db, team.id, "test-token", "newbie", "viewer");
    assert.equal((await listAccountMembers(db, team.id)).find(member => member.githubId === 3)?.signedIn, 0);
    await ensurePersonalAccount(db, { id: 3, login: "newbie", avatarUrl: "" });
    assert.equal((await listAccountMembers(db, team.id)).find(member => member.githubId === 3)?.signedIn, 1);
    assert.equal((await listAccounts(db, 3)).find(account => account.id === team.id)?.role, "viewer");
    await setAccountMember(db, team.id, "test-token", "member", "viewer");
    await assert.rejects(accountAccess(db, 2, team.id, "admin"), /do not have access/);
    assert.equal((await listAccountMembers(db, team.id)).length, 3);
    await setAccountMember(db, team.id, "test-token", "member", "admin");
    assert.equal((await accountAccess(db, 2, team.id, "admin")).role, "admin");
    await assert.rejects(setAccountMember(db, team.id, "test-token", "owner", "viewer"), /owner role/);
    await assert.rejects(removeAccountMember(db, team.id, 1), /owner cannot/);
    const repo = { id: 42, fullName: "owner/repo", installationId: 7, defaultBranch: "main" };
    const project = await linkProject(db, team.id, repo);
    assert.deepEqual((await listProjects(db, 2, [repo]))[0], { ...project,
      accountId: team.id, accountName: "Product team", role: "admin", accountRole: "admin" });
    sqlite.prepare("INSERT INTO project_memberships (project_id, github_id, role) VALUES (?, 2, 'editor')").run(project.id);
    await removeAccountMember(db, team.id, 2);
    assert.deepEqual(await listProjects(db, 2, [repo]), []);
    assert.deepEqual(await listProjectMembers(db, project.id), []);
  } finally { globalThis.fetch = original; sqlite.close(); }
});

test("signed merge webhook records only a tracked spec-only PR", async () => {
  const { sqlite, db } = testDb();
  const original = globalThis.fetch;
  try {
    const account = await ensurePersonalAccount(db, { id: 1, login: "owner", avatarUrl: "" });
    const project = await linkProject(db, account, { id: 42, fullName: "owner/repo", installationId: 7, defaultBranch: "main" });
    sqlite.prepare("INSERT INTO skills (id, account_id, project_id, source_repo_id, path, commit_sha, active) VALUES ('skill-1', ?, NULL, 42, '.fava/skills/review.md', ?, 1)")
      .run(account, "b".repeat(40));
    sqlite.prepare("INSERT INTO mcp_grants (id, project_id, server_url, allowed_tools_json, granted_by, granted_at) VALUES ('grant-1', ?, 'https://mcp.example.org/mcp', '[\"list\"]', 1, 1)")
      .run(project.id);
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
    assert.equal(sqlite.prepare("SELECT grant_id AS grantId FROM run_mcp_grants").get().grantId, "grant-1");
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
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM run_mcp_grants").get().count, 1);
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
  const session = { id: crypto.randomUUID(), token: "sensitive-token", expiresAt: Date.now() + 1000,
    user: { id: 1, login: "test", avatarUrl: "" } };
  const cookie = await seal(session);
  assert.equal(cookie.includes(session.token), false);
  assert.deepEqual(await unseal(cookie), session);
  assert.equal(await unseal((cookie.startsWith("A") ? "B" : "A") + cookie.slice(1)), null);
});

test("logout revokes a session in D1 even if its encrypted cookie is reused", async () => {
  process.env.FAVA_SESSION_SECRET = "test-secret-that-is-at-least-32-characters-long";
  const { db, sqlite } = testDb();
  try {
    await ensurePersonalAccount(db, { id: 1, login: "test", avatarUrl: "" });
    const session = { id: crypto.randomUUID(), token: "sensitive-token",
      expiresAt: Date.now() + 600_000, refreshExpiresAt: Date.now() + 86_400_000,
      user: { id: 1, login: "test", avatarUrl: "" } };
    await createSession(db, session);
    const cookie = await seal(session);
    const reused = { cookies: { get: () => ({ value: cookie }) } };
    assert.equal((await readSession(reused, db)).session.user.id, 1);
    await revokeSession(db, reused);
    assert.equal(await readSession(reused, db), null);
    assert.equal(sqlite.prepare("SELECT id_hash FROM sessions").get().id_hash.includes(session.id), false);
  } finally { sqlite.close(); }
});

test("GitHub authorization revocation invalidates only that user's sessions", async () => {
  process.env.FAVA_SESSION_SECRET = "test-secret-that-is-at-least-32-characters-long";
  const { db, sqlite } = testDb();
  try {
    const sessions = [];
    for (const id of [1, 1, 2]) {
      await ensurePersonalAccount(db, { id, login: `user${id}`, avatarUrl: "" });
      const session = { id: crypto.randomUUID(), token: `token-${id}`,
        expiresAt: Date.now() + 600_000, user: { id, login: `user${id}`, avatarUrl: "" } };
      await createSession(db, session);
      const cookie = await seal(session);
      sessions.push({ cookies: { get: () => ({ value: cookie }) } });
    }
    await assert.rejects(processAuthorizationRevocation(db, { action: "revoked", sender: { id: "1" } }),
      /Invalid authorization webhook/);
    assert.deepEqual(await processAuthorizationRevocation(db, { action: "revoked", sender: { id: 1 } }),
      { revoked: true });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE github_id = 1 AND revoked_at IS NOT NULL").get().count, 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE github_id = 2 AND revoked_at IS NULL").get().count, 1);
    assert.equal(await readSession(sessions[0], db), null);
    assert.equal(await readSession(sessions[1], db), null);
    assert.equal((await readSession(sessions[2], db)).session.user.id, 2);
  } finally { sqlite.close(); }
});

test("installation removal cancels only affected runs and requires relinking", async () => {
  const { db, sqlite } = testDb();
  try {
    const account = await ensurePersonalAccount(db, { id: 1, login: "owner", avatarUrl: "" });
    const first = { id: 42, fullName: "owner/first", installationId: 7, defaultBranch: "main" };
    const second = { id: 43, fullName: "owner/second", installationId: 7, defaultBranch: "main" };
    const a = await linkProject(db, account, first);
    const b = await linkProject(db, account, second);
    for (const [id, project] of [["a", a], ["b", b]]) {
      await recordSpec(db, project.id, 1,
        { number: 1, path: `specs/${id}.md`, branch: `spec/${id}` }, chooseModel("gpt-6-sol"));
      const specId = sqlite.prepare("SELECT id FROM specs WHERE project_id = ?").get(project.id).id;
      sqlite.prepare("INSERT INTO runs (id, spec_id, merged_commit_sha, model, provider, status, created_at) VALUES (?, ?, ?, 'gpt-6-sol', 'openai', 'queued', 1)")
        .run(id, specId, "a".repeat(40));
    }
    assert.deepEqual(await processInstallationLoss(db, { action: "removed", installation: { id: 7 },
      repositories_removed: [{ id: 42 }] }, "installation_repositories", "removed-1"), { disconnected: true });
    assert.equal(sqlite.prepare("SELECT installation_id FROM projects WHERE id = ?").get(a.id).installation_id, 0);
    assert.equal(sqlite.prepare("SELECT installation_id FROM projects WHERE id = ?").get(b.id).installation_id, 7);
    assert.equal(sqlite.prepare("SELECT status FROM runs WHERE id = 'a'").get().status, "cancelled");
    assert.equal(sqlite.prepare("SELECT status FROM runs WHERE id = 'b'").get().status, "queued");
    assert.deepEqual((await listProjects(db, 1, [first, second])).map(project => project.repository), [second.fullName]);
    await assert.rejects(projectAccess(db, 1, first.fullName, "token"), /do not have access/);
    assert.equal((await linkProject(db, account, first)).id, a.id);
    assert.deepEqual(await processInstallationLoss(db, { action: "removed", installation: { id: 7 },
      repositories_removed: [{ id: 42 }] }, "installation_repositories", "removed-1"),
    { disconnected: true, duplicate: true });
    assert.equal(sqlite.prepare("SELECT installation_id FROM projects WHERE id = ?").get(a.id).installation_id, 7);
    await processInstallationLoss(db, { action: "deleted", installation: { id: 7 } }, "installation", "deleted-1");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM projects WHERE installation_id = 7").get().count, 0);
    assert.equal(sqlite.prepare("SELECT status FROM runs WHERE id = 'b'").get().status, "cancelled");
  } finally { sqlite.close(); }
});

test("successful Worker Preview is attached only to the matching implementation commit", async () => {
  const { db, sqlite } = testDb();
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.FAVA_SESSION_SECRET;
  process.env.FAVA_SESSION_SECRET = "a-secure-example-secret-with-more-than-32-characters";
  try {
    const account = await ensurePersonalAccount(db, { id: 1, login: "owner", avatarUrl: "" });
    const project = await linkProject(db, account,
      { id: 42, fullName: "owner/repo", installationId: 7, defaultBranch: "main" });
    await recordSpec(db, project.id, 1,
      { number: 1, path: "specs/change.md", branch: "spec/change" }, chooseModel("gpt-6-sol"));
    const specId = sqlite.prepare("SELECT id FROM specs WHERE project_id = ?").get(project.id).id;
    const runId = "11111111-1111-4111-8111-111111111111";
    const sha = "b".repeat(40);
    sqlite.prepare("INSERT INTO runs (id, spec_id, merged_commit_sha, model, provider, status, created_at, completed_at, implementation_branch, implementation_sha, pull_number) VALUES (?, ?, ?, 'gpt-6-sol', 'openai', 'succeeded', 1, ?, ?, ?, 8)")
      .run(runId, specId, "a".repeat(40), Date.now(), `impl/${runId}`, sha);
    const token = await encryptToken("cloudflare-test-token");
    sqlite.prepare("INSERT INTO cloudflare_connections VALUES (?, ?, ?, 1)").run(account, "c".repeat(32), token);
    sqlite.prepare("INSERT INTO cloudflare_project_previews VALUES (?, ?, 'worker', 'tag', 'trigger', 1)")
      .run(project.id, account);
    let calls = 0;
    globalThis.fetch = async url => {
      calls++;
      if (String(url).endsWith("/builds/workers/tag/builds?per_page=100"))
        return Response.json({ success: true, result: [
          { build_uuid: "wrong-trigger", build_outcome: "success", trigger: { trigger_uuid: "other" },
            build_trigger_metadata: { branch: `impl/${runId}`, commit_hash: sha } },
          { build_uuid: "wrong-commit", build_outcome: "success", trigger: { trigger_uuid: "trigger" },
            build_trigger_metadata: { branch: `impl/${runId}`, commit_hash: "c".repeat(40) } },
          { build_uuid: "right", build_outcome: "success", trigger: { trigger_uuid: "trigger" },
            build_trigger_metadata: { branch: `impl/${runId}`, commit_hash: sha } },
        ] });
      assert.equal(String(url).endsWith("/builds/builds/right"), true);
      return Response.json({ success: true, result: { preview_url: "https://branch.example.workers.dev" } });
    };
    const runs = await listRuns(db, account, "owner/repo");
    await refreshRunPreviews(db, account, project.id, runs);
    assert.equal(runs[0].previewUrl, "https://branch.example.workers.dev");
    assert.equal(sqlite.prepare("SELECT preview_url FROM runs WHERE id = ?").get(runId).preview_url,
      "https://branch.example.workers.dev");
    await refreshRunPreviews(db, account, project.id, runs);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.FAVA_SESSION_SECRET;
    else process.env.FAVA_SESSION_SECRET = originalSecret;
    sqlite.close();
  }
});
