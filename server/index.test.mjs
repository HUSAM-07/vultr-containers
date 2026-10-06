import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "forge-test-"));
process.env.FORGE_DATA_FILE = join(dir, "runs.json");
const { parsePlan, parseArtifact, dockerArgs, app } = await import("./index.mjs");
test("validates plans and sets sandbox boundaries", () => {
  assert.deepEqual(parsePlan('{"plan":["run"],"code":"print(1)"}'), { plan: ["run"], code: "print(1)" });
  assert.throws(() => parsePlan('{"plan":[],"code":""}'));
  const args = dockerArgs("test", "print(1)");
  for (const flag of ["--network", "none", "--read-only", "--memory", "--pids-limit", "--cap-drop", "ALL", "--user"])
    assert.ok(args.includes(flag));
  assert.equal(args.at(-1), "print(1)");
});

test("extracts a bounded preview from executed output", () => {
  assert.deepEqual(parseArtifact('verified\nFORGE_ARTIFACT:{"html":"<h1>Ready</h1>"}\n'),
    { stdout: "verified\n", artifact: "<h1>Ready</h1>" });
  assert.deepEqual(parseArtifact("verified"), { stdout: "verified" });
  assert.throws(() => parseArtifact('FORGE_ARTIFACT:{"html":""}'));
});

test("runs and previews stay inside the visitor session", async () => {
  const docker = join(dir, "docker");
  writeFileSync(docker, "#!/bin/sh\nprintf '%s\\n' 'verified' 'FORGE_ARTIFACT:{\"html\":\"<h1>Ready</h1>\"}'\n");
  chmodSync(docker, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = dir + ":" + oldPath;
  process.env.WEB_BACKEND_TOKEN = "test-token";
  process.env.VULTR_INFERENCE_API_KEY = "test-key";
  process.env.VULTR_MODEL = "test-model";
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => String(input).startsWith("https://api.vultrinference.com/")
    ? Promise.resolve(new Response(JSON.stringify({ choices: [{ message: {
      content: '{"plan":["build"],"code":"print(1)"}',
    } }] }), { status: 200 }))
    : nativeFetch(input, options);
  const server = app();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const request = (path, owner, options = {}) => fetch(url + path, {
    ...options,
    headers: { Authorization: "Bearer test-token", "X-Session-Id": owner,
      "Content-Type": "application/json" },
  });
  try {
    const created = await request("/runs", a, { method: "POST",
      body: JSON.stringify({ task: "demo", mode: "containment" }) });
    assert.equal(created.status, 202);
    const run = await created.json();
    assert.equal(run.ownerId, undefined);
    const mine = await (await request("/runs", a)).json();
    const others = await (await request("/runs", b)).json();
    assert.equal(mine.length, 1);
    assert.deepEqual(others, []);
    assert.equal((await request("/runs/" + run.id, b)).status, 404);
    assert.equal((await request("/runs", "")).status, 401);
    const built = await (await request("/runs", a, { method: "POST",
      body: JSON.stringify({ task: "Build a page" }) })).json();
    let detail;
    for (let attempt = 0; attempt < 100; attempt++) {
      detail = await (await request("/runs/" + built.id, a)).json();
      if (detail.status === "succeeded" || detail.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(detail.status, "succeeded");
    assert.equal(detail.artifact, "<h1>Ready</h1>");
    assert.equal(detail.output.stdout, "verified\n");
    assert.equal((await (await request("/runs", a)).json())[0].artifact, undefined);
    assert.equal((await request("/runs/" + built.id, b)).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    process.env.PATH = oldPath;
    globalThis.fetch = nativeFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
