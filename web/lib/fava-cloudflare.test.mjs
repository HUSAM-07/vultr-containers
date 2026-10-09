import test from "node:test";
import assert from "node:assert/strict";
import { CloudflareError, decryptToken, encryptToken, recentPreviewBuilds, verifyPreviewConfig } from "./fava-cloudflare.ts";

test("Cloudflare token is encrypted and round trips", async () => {
  process.env.FAVA_SESSION_SECRET = "a-secure-example-secret-with-more-than-32-characters";
  const encrypted = await encryptToken("secret-token-that-must-not-appear-in-d1");
  assert.doesNotMatch(encrypted, /secret-token/);
  assert.equal(await decryptToken(encrypted), "secret-token-that-must-not-appear-in-d1");
  const [iv, data] = encrypted.split(".");
  await assert.rejects(decryptToken(`${iv}.${data[0] === "A" ? "B" : "A"}${data.slice(1)}`), CloudflareError);
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

test("Preview config requires environment Durable Object bindings", () => {
  const binding = { name: "DATABASE", class_name: "Database" };
  const config = { name: "app", durable_objects: { bindings: [binding] }, previews: {} };
  assert.throws(() => verifyPreviewConfig(JSON.stringify(config), "app"), CloudflareError);
  assert.equal(verifyPreviewConfig(JSON.stringify({ ...config,
    previews: { durable_objects: { bindings: [binding] } } }), "app").name, "app");
});

test("recent previews stay on the configured trigger and show the latest build per branch", () => {
  const builds = [
    { build_uuid: "old", created_on: "2026-10-01", build_trigger_metadata: { branch: "feature" }, trigger: { trigger_uuid: "preview" } },
    { build_uuid: "production", created_on: "2026-10-05", build_trigger_metadata: { branch: "main" }, trigger: { trigger_uuid: "production" } },
    { build_uuid: "new", created_on: "2026-10-03", build_trigger_metadata: { branch: "feature" }, trigger: { trigger_uuid: "preview" }, preview_url: "https://example.workers.dev" },
    { build_uuid: "other", created_on: "2026-10-02", build_trigger_metadata: { branch: "another" }, trigger: { trigger_uuid: "preview" }, preview_url: "javascript:alert(1)" },
  ];
  assert.deepEqual(recentPreviewBuilds(builds, "preview"), [
    { branch: "feature", buildUuid: "new", status: "unknown", outcome: null, url: "https://example.workers.dev" },
    { branch: "another", buildUuid: "other", status: "unknown", outcome: null, url: null },
  ]);
});
