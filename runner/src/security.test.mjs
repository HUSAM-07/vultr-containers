import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readRunCapability, runCapability } from "./capability.ts";
import { appJwt, installationToken, isGitReadRequest } from "./github.ts";

test("run capability is scoped to its signed random ID", () => {
  const id = randomUUID();
  const secret = "a".repeat(40);
  const value = runCapability(id, secret);
  assert.equal(readRunCapability(value, secret), id);
  assert.equal(readRunCapability(value, "b".repeat(40)), null);
  assert.equal(readRunCapability(randomUUID() + value.slice(36), secret), null);
  assert.equal(readRunCapability(null, secret), null);
  assert.throws(() => runCapability(id, "short"), /configuration/);
  assert.equal(createHmac("sha256", secret).update(id).digest("hex"), value.slice(37));
});

test("Git gateway accepts only upload-pack reads for the exact repository", () => {
  const repo = "owner/private";
  assert.equal(isGitReadRequest(new URL(`https://github.com/${repo}.git/info/refs?service=git-upload-pack`), "GET", repo), true);
  assert.equal(isGitReadRequest(new URL(`https://github.com/${repo}.git/git-upload-pack`), "POST", repo), true);
  for (const [url, method] of [
    [`https://github.com/${repo}.git/git-receive-pack`, "POST"],
    [`https://github.com/owner/other.git/info/refs?service=git-upload-pack`, "GET"],
    [`http://github.com/${repo}.git/info/refs?service=git-upload-pack`, "GET"],
    [`https://evil.example/${repo}.git/info/refs?service=git-upload-pack`, "GET"],
  ]) assert.equal(isGitReadRequest(new URL(url), method, repo), false);
});

test("GitHub App JWT signs and installation token is restricted to one repository", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = appJwt("Iv1.test", privateKey.export({ type: "pkcs1", format: "pem" }));
  const [header, claims, signature] = jwt.split(".");
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey,
    Buffer.from(signature, "base64url")), true);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.github.com/app/installations/7/access_tokens");
      assert.deepEqual(JSON.parse(init.body), { repository_ids: [42], permissions: { contents: "read" } });
      return Response.json({ token: "restricted-token" });
    };
    assert.equal(await installationToken(jwt, 7, 42), "restricted-token");
  } finally { globalThis.fetch = original; }
});

test("publishing token requests write access only to the selected repository", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), { repository_ids: [42],
        permissions: { contents: "write", pull_requests: "write" } });
      return Response.json({ token: "publish-token" });
    };
    assert.equal(await installationToken("jwt", 7, 42, "publish"), "publish-token");
  } finally { globalThis.fetch = original; }
});
