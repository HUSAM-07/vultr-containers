import test from "node:test";
import assert from "node:assert/strict";
import { CloudflareError, decryptToken, encryptToken, verifyPreviewConfig } from "./fava-cloudflare.ts";

test("Cloudflare token is encrypted and round trips", async () => {
  process.env.FAVA_SESSION_SECRET = "a-secure-example-secret-with-more-than-32-characters";
  const encrypted = await encryptToken("secret-token-that-must-not-appear-in-d1");
  assert.doesNotMatch(encrypted, /secret-token/);
  assert.equal(await decryptToken(encrypted), "secret-token-that-must-not-appear-in-d1");
  await assert.rejects(decryptToken(encrypted.slice(0, -1) + "x"), CloudflareError);
});

test("Preview config rejects shared D1 and missing Preview bindings", () => {
  const config = { name: "app", d1_databases: [{ binding: "DB", database_id: "production" }],
    previews: { d1_databases: [{ binding: "DB", database_id: "preview" }] } };
  assert.equal(verifyPreviewConfig(JSON.stringify(config), "app").name, "app");
  assert.throws(() => verifyPreviewConfig(JSON.stringify({ ...config, previews: { d1_databases: [{ binding: "DB", database_id: "production" }] } }), "app"), CloudflareError);
  assert.throws(() => verifyPreviewConfig(JSON.stringify({ ...config, previews: {} }), "app"), CloudflareError);
  assert.throws(() => verifyPreviewConfig(JSON.stringify({ ...config, previews: undefined }), "app"), CloudflareError);
  assert.equal(verifyPreviewConfig(`// a JSONC comment\n${JSON.stringify(config)}`, "app").name, "app");
  const storage = { name: "app", r2_buckets: [{ binding: "ASSETS", bucket_name: "prod" }],
    kv_namespaces: [{ binding: "CACHE", id: "prod" }], previews: {
      r2_buckets: [{ binding: "ASSETS", bucket_name: "preview" }],
      kv_namespaces: [{ binding: "CACHE", id: "preview" }],
    } };
  assert.equal(verifyPreviewConfig(JSON.stringify(storage), "app").name, "app");
  assert.throws(() => verifyPreviewConfig(JSON.stringify({ ...storage,
    previews: { ...storage.previews, r2_buckets: storage.r2_buckets } }), "app"), CloudflareError);
  assert.throws(() => verifyPreviewConfig(JSON.stringify({ ...storage,
    previews: { ...storage.previews, kv_namespaces: storage.kv_namespaces } }), "app"), CloudflareError);
});
