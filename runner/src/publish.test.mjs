import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { publishImplementation } from "./publish.ts";

const id = "11111111-1111-4111-8111-111111111111";
const base = "a".repeat(40);
const head = "b".repeat(40);
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = { GITHUB_APP_CLIENT_ID: "Iv1.test", GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }) };
const run = { id, repository: "owner/private", repositoryId: 42, installationId: 7,
  sha: base, defaultBranch: "main", specPath: "specs/change.md", specPullNumber: 4 };

test("publication retries reuse the pinned branch and existing draft PR", async () => {
  const original = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, options) => {
      requests.push([url, options.method]);
      if (url.endsWith("/app/installations/7/access_tokens")) {
        assert.deepEqual(JSON.parse(options.body), { repository_ids: [42],
          permissions: { contents: "write", pull_requests: "write" } });
        return Response.json({ token: "publisher" });
      }
      if (url.endsWith(`/git/commits/${base}`)) return Response.json({ tree: { sha: "c".repeat(40) } });
      if (url.endsWith("/git/blobs")) return Response.json({ sha: "d".repeat(40) });
      if (url.endsWith("/git/trees")) return Response.json({ sha: "e".repeat(40) });
      if (url.endsWith(`/git/ref/heads/impl/${id}`)) return Response.json({ object: { sha: head } });
      if (url.endsWith(`/git/commits/${head}`))
        return Response.json({ message: `impl: spec #4\n\nFava run ${id}`, parents: [{ sha: base }],
          tree: { sha: "e".repeat(40) } });
      if (url.includes("/pulls?")) return Response.json([{ number: 8, html_url: "https://github.com/owner/private/pull/8",
        state: "open", head: { ref: `impl/${id}`, sha: head }, base: { ref: "main" } }]);
      throw Error(`Unexpected request: ${url}`);
    };
    assert.deepEqual(await publishImplementation(env, run,
      [{ path: "src/a.ts", mode: "100644", content: "YQ==" }], "Done"),
    { branch: `impl/${id}`, sha: head, pullNumber: 8, url: "https://github.com/owner/private/pull/8" });
    assert.equal(requests.length, 7);
    assert.equal(requests.every(([, method]) => method === "POST" || method === "GET"), true);
  } finally { globalThis.fetch = original; }
});

test("publication refuses a branch with different code than the agent produced", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      if (url.endsWith("/app/installations/7/access_tokens")) return Response.json({ token: "publisher" });
      if (url.endsWith(`/git/commits/${base}`)) return Response.json({ tree: { sha: "c".repeat(40) } });
      if (url.endsWith("/git/blobs")) return Response.json({ sha: "d".repeat(40) });
      if (url.endsWith("/git/trees")) return Response.json({ sha: "e".repeat(40) });
      if (url.endsWith(`/git/ref/heads/impl/${id}`)) return Response.json({ object: { sha: head } });
      if (url.endsWith(`/git/commits/${head}`)) return Response.json({ message: `Fava run ${id}`,
        parents: [{ sha: base }], tree: { sha: "f".repeat(40) } });
      throw Error(`Unexpected request: ${url}`);
    };
    await assert.rejects(publishImplementation(env, run,
      [{ path: "src/a.ts", mode: "100644", content: "YQ==" }], "Done"), /changed outside this run/);
  } finally { globalThis.fetch = original; }
});
