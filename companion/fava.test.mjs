import assert from "node:assert/strict";
import { test } from "node:test";
import { agentEnvironment, createClient, runClaim, runProcess, serverOrigin, validateJob } from "./fava.mjs";

const job = { id: "11111111-1111-4111-8111-111111111111", leaseId: "22222222-2222-4222-8222-222222222222",
  repository: "owner/repo", sha: "a".repeat(40), specPath: "specs/change.md",
  provider: "openai", model: "gpt-6-sol", pinnedSkills: 0, pinnedMcpGrants: 0 };

test("the companion validates the server and pinned run before using local credentials", () => {
  assert.equal(serverOrigin("https://fava.example/"), "https://fava.example");
  assert.throws(() => serverOrigin("http://fava.example"), /HTTPS origin/);
  assert.throws(() => serverOrigin("https://fava.example/other"), /HTTPS origin/);
  assert.equal(validateJob(job), job);
  assert.throws(() => validateJob({ ...job, repository: "owner/../other" }), /invalid local run/);
  assert.throws(() => validateJob({ ...job, model: "other" }), /invalid local run/);
  assert.deepEqual(agentEnvironment({ PATH: "/bin", FAVA_DEVICE_TOKEN: "secret", GH_TOKEN: "gh",
    OPENAI_API_KEY: "key" }), { PATH: "/bin" });
});

test("device requests carry only the paired token and refuse redirects", async () => {
  const calls = [];
  const client = createClient("https://fava.example", `fava_dev_${"a".repeat(43)}`,
    async (url, init) => { calls.push({ url, init }); return Response.json({ pending: true }); });
  assert.deepEqual(await client({ action: "claim" }), { pending: true });
  assert.equal(calls[0].url, "https://fava.example/api/devices/runs");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.Authorization, `Bearer fava_dev_${"a".repeat(43)}`);
});

test("an expired lease signal stops the local child process", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const child = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
    { signal: controller.signal, timeout: 5_000 });
  setTimeout(() => controller.abort(Error("Lease lost")), 150);
  await assert.rejects(child, /Lease lost/);
  assert.ok(Date.now() - started < 2_000);
});

test("unsupported pinned MCP grants fail the claimed run before checkout", async () => {
  const actions = [];
  await assert.rejects(runClaim({ ...job, pinnedMcpGrants: 1 }, async body => {
    actions.push(body);
    return { status: "failed" };
  }), /does not yet support pinned MCP grants/);
  assert.deepEqual(actions.map(action => action.action), ["fail"]);
  assert.equal(actions[0].runId, job.id);
});

test("a local run requests its pinned skills before cloning", async () => {
  const actions = [];
  await assert.rejects(runClaim({ ...job, pinnedSkills: 1 }, async body => {
    actions.push(body.action);
    return body.action === "skills" ? { skills: "" } : { status: "failed" };
  }), /invalid pinned skills/);
  assert.deepEqual(actions, ["skills", "fail"]);
});
