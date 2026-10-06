import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "forge-test-"));
process.env.FORGE_DATA_FILE = join(dir, "runs.json");
const { parsePlan, dockerArgs, app } = await import("./index.mjs");
test("validates plans and sets sandbox boundaries", () => {
  assert.deepEqual(parsePlan('{"plan":["run"],"code":"print(1)"}'), { plan: ["run"], code: "print(1)" });
  assert.throws(() => parsePlan('{"plan":[],"code":""}'));
  const args = dockerArgs("test", "print(1)");
  for (const flag of ["--network", "none", "--read-only", "--memory", "--pids-limit", "--cap-drop", "ALL", "--user"])
    assert.ok(args.includes(flag));
  assert.equal(args.at(-1), "print(1)");
});

test("runs stay inside the signed visitor session", async () => {
  const docker = join(dir, "docker");
  writeFileSync(docker, "#!/bin/sh\nprintf 'mock sandbox\\n'\n");
  chmodSync(docker, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = dir + ":" + oldPath;
  process.env.WEB_BACKEND_TOKEN = "test-token";
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
  } finally {
    await new Promise(resolve => server.close(resolve));
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
