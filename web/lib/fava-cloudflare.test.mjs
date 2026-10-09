import test from "node:test";
import assert from "node:assert/strict";
import { CloudflareError, decryptToken, encryptToken, productionTrigger, recentPreviewBuilds, verifyPreviewConfig, wranglerConfigPaths } from "./fava-cloudflare.ts";

test("selects the production trigger for the linked GitHub repository", () => {
  const triggers = [
    { trigger_uuid: "wrong", branch_includes: ["main"], repo_connection_uuid: "other",
      repo_connection: { provider_type: "github", repo_id: "12" } },
    { trigger_uuid: "right", branch_includes: ["main"], repo_connection_uuid: "linked",
      repo_connection: { provider_type: "github", repo_id: "34" } },
  ];
  assert.equal(productionTrigger(triggers, "main", 34)?.trigger_uuid, "right");
  assert.equal(productionTrigger(triggers, "main", 56), undefined);
  assert.equal(productionTrigger(triggers.map(({ repo_connection, ...trigger }) => trigger),
    "main", 34, "linked")?.trigger_uuid, "right");
});

test("Wrangler config lookup follows the Worker Builds root directory", () => {
  assert.deepEqual(wranglerConfigPaths("/"), ["wrangler.jsonc", "wrangler.json"]);
  assert.deepEqual(wranglerConfigPaths("/apps/my worker"),
    ["apps/my%20worker/wrangler.jsonc", "apps/my%20worker/wrangler.json"]);
  assert.deepEqual(wranglerConfigPaths("./web/"), ["web/wrangler.jsonc", "web/wrangler.json"]);
  assert.throws(() => wranglerConfigPaths("../private"), CloudflareError);
});

test("Cloudflare token is encrypted and round trips", async () => {
  process.env.FAVA_SESSION_SECRET = "a-secure-example-secret-with-more-than-32-characters";
  const encrypted = await encryptToken("secret-token-that-must-not-appear-in-d1");
  assert.doesNotMatch(encrypted, /secret-token/);
  assert.equal(await decryptToken(encrypted), "secret-token-that-must-not-appear-in-d1");
  const [iv, data] = encrypted.split(".");
  await assert.rejects(decryptToken(`${iv}.${data[0] === "A" ? "B" : "A"}${data.slice(1)}`), CloudflareError);
  const mcp = await encryptToken("mcp-provider-secret", "mcp");
  assert.equal(await decryptToken(mcp, "mcp"), "mcp-provider-secret");
  await assert.rejects(decryptToken(mcp), CloudflareError);
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

test("Preview config isolates other account resources and declares containers and variables", () => {
  const config = { name: "app", vectorize: [{ binding: "SEARCH", index_name: "prod-index" }],
    pipelines: [{ binding: "EVENTS", pipeline: "prod-stream" }],
    queues: { producers: [{ binding: "JOBS", queue: "prod-jobs" }] },
    secrets_store_secrets: [{ binding: "API_KEY", store_id: "store", secret_name: "prod-key" }],
    containers: [{ class_name: "Runner", image: "./Dockerfile" }], vars: { ENVIRONMENT: "production" },
    previews: { vectorize: [{ binding: "SEARCH", index_name: "preview-index" }],
      pipelines: [{ binding: "EVENTS", stream: "preview-stream" }],
      queues: { producers: [{ binding: "JOBS", queue: "preview-jobs" }] },
      secrets_store_secrets: [{ binding: "API_KEY", store_id: "store", secret_name: "preview-key" }],
      containers: [{ class_name: "Runner", image: "./Dockerfile" }], vars: { ENVIRONMENT: "preview" } } };
  assert.equal(verifyPreviewConfig(JSON.stringify(config), "app").name, "app");
  for (const previews of [
    { ...config.previews, vectorize: config.vectorize },
    { ...config.previews, pipelines: [{ binding: "EVENTS", stream: "prod-stream" }] },
    { ...config.previews, queues: config.queues },
    { ...config.previews, secrets_store_secrets: config.secrets_store_secrets },
    { ...config.previews, containers: [] },
    { ...config.previews, vars: {} },
  ]) assert.throws(() => verifyPreviewConfig(JSON.stringify({ ...config, previews }), "app"), CloudflareError);
});

test("Preview config repeats API bindings, Worker Loaders, and define names", () => {
  const config = { name: "app", ai: { binding: "AI" }, browser: { binding: "BROWSER" },
    worker_loaders: [{ binding: "LOADER" }], define: { API_URL: "prod" },
    previews: { ai: { binding: "AI" }, browser: { binding: "BROWSER" },
      worker_loaders: [{ binding: "LOADER" }], define: { API_URL: "preview" } } };
  assert.equal(verifyPreviewConfig(JSON.stringify(config), "app").name, "app");
  for (const previews of [
    { ...config.previews, ai: undefined },
    { ...config.previews, browser: { binding: "OTHER" } },
    { ...config.previews, worker_loaders: [] },
    { ...config.previews, define: {} },
  ]) assert.throws(() => verifyPreviewConfig(JSON.stringify({ ...config, previews }), "app"), CloudflareError);
});

test("recent previews stay on the configured trigger and show the latest build per branch", () => {
  const builds = [
    { build_uuid: "old", created_on: "2026-10-01", build_trigger_metadata: { branch: "feature" }, trigger: { trigger_uuid: "preview" } },
    { build_uuid: "production", created_on: "2026-10-05", build_trigger_metadata: { branch: "main" }, trigger: { trigger_uuid: "production" } },
    { build_uuid: "new", created_on: "2026-10-03", build_trigger_metadata: { branch: "feature" }, trigger: { trigger_uuid: "preview" }, build_outcome: "success", preview_url: "https://example.workers.dev" },
    { build_uuid: "other", created_on: "2026-10-02", build_trigger_metadata: { branch: "another" }, trigger: { trigger_uuid: "preview" }, build_outcome: "success", preview_url: "javascript:alert(1)" },
    { build_uuid: "failed", created_on: "2026-10-04", build_trigger_metadata: { branch: "broken" }, trigger: { trigger_uuid: "preview" }, build_outcome: "failure", preview_url: "https://old-preview.workers.dev" },
  ];
  assert.deepEqual(recentPreviewBuilds(builds, "preview"), [
    { branch: "broken", buildUuid: "failed", status: "unknown", outcome: "failure", url: null },
    { branch: "feature", buildUuid: "new", status: "unknown", outcome: "success", url: "https://example.workers.dev" },
    { branch: "another", buildUuid: "other", status: "unknown", outcome: "success", url: null },
  ]);
});
