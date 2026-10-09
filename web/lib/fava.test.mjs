import test from "node:test";
import assert from "node:assert/strict";
import { importContext, publishSpec, validateSpec } from "./fava-github.ts";
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

test("session cookie is encrypted and rejects tampering", async () => {
  process.env.FAVA_SESSION_SECRET = "test-secret-that-is-at-least-32-characters-long";
  const session = { token: "sensitive-token", expiresAt: Date.now() + 1000,
    user: { id: 1, login: "test", avatarUrl: "" } };
  const cookie = await seal(session);
  assert.equal(cookie.includes(session.token), false);
  assert.deepEqual(await unseal(cookie), session);
  assert.equal(await unseal(cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A")), null);
});
