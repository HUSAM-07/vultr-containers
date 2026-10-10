import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnvironment, createClient, localMcpConfiguration, runClaim, runProcess, serverOrigin, validateJob } from "./fava.mjs";

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
    OPENAI_API_KEY: "key", FAVA_MCP_0: "stale" }), { PATH: "/bin" });
});

test("device requests carry only the paired token and refuse redirects", async () => {
  const calls = [];
  const client = createClient("https://fava.example", `fava_dev_${"a".repeat(43)}`,
    async (url, init) => { calls.push({ url, init }); return Response.json({ pending: true }); });
  assert.deepEqual(await client({ action: "claim" }), { pending: true });
  assert.equal(calls[0].url, "https://fava.example/api/devices/runs");
  assert.equal(client.origin, "https://fava.example");
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

test("malformed pinned MCP grants fail the claimed run before checkout", async () => {
  const actions = [];
  const client = async body => {
    actions.push(body);
    return body.action === "mcp" ? { grants: [{ id: "invalid" }] } : { status: "failed" };
  };
  client.origin = "https://fava.example";
  await assert.rejects(runClaim({ ...job, pinnedMcpGrants: 1 }, client), /invalid MCP grants/);
  assert.deepEqual(actions.map(action => action.action), ["mcp", "fail"]);
  assert.equal(actions[0].runId, job.id);
});

test("local MCP config passes only run-scoped grants to provider CLIs", () => {
  const token = `${job.leaseId}.${"a".repeat(64)}`;
  const grant = { id: "33333333-3333-4333-8333-333333333333", token,
    allowedTools: ["aws.list_buckets"] };
  const config = localMcpConfiguration([grant], "https://fava.example", job.id);
  assert.deepEqual(config.environment, { FAVA_MCP_0: token });
  assert.equal(JSON.stringify(config.codexArgs).includes(token), false);
  assert.equal(config.codexArgs.some(value => value.includes("enabled_tools") && value.includes("aws.list_buckets")), true);
  const claude = JSON.parse(config.claudeArgs[1]);
  assert.deepEqual(claude.mcpServers.fava_0, { type: "http",
    url: `https://fava.example/api/devices/mcp/${job.id}/${grant.id}`,
    headers: { Authorization: "Bearer ${FAVA_MCP_0}" } });
  assert.throws(() => localMcpConfiguration([{ ...grant, id: "other" }], "https://fava.example", job.id), /invalid MCP grants/);
});

test("a local run requests its pinned skills before cloning", async () => {
  const actions = [];
  await assert.rejects(runClaim({ ...job, pinnedSkills: 1 }, async body => {
    actions.push(body.action);
    return body.action === "skills" ? { skills: "" } : { status: "failed" };
  }), /invalid pinned skills/);
  assert.deepEqual(actions, ["skills", "fail"]);
});

test("a claimed run checks out its pinned commit and submits only its staged change", async () => {
  const root = await mkdtemp(join(tmpdir(), "fava-companion-test-"));
  const source = join(root, "source");
  const bin = join(root, "bin");
  const previous = Object.fromEntries(["PATH", "FAVA_DEVICE_TOKEN", "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].map(name => [name, process.env[name]]));
  try {
    await mkdir(join(source, "specs"), { recursive: true });
    await mkdir(bin);
    execFileSync("git", ["init", "-q", source]);
    execFileSync("git", ["-C", source, "config", "user.name", "Fava Test"]);
    execFileSync("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(source, "specs", "change.md"), "## Outcome\nAdd an outcome file.\n");
    execFileSync("git", ["-C", source, "add", "specs/change.md"]);
    execFileSync("git", ["-C", source, "commit", "-qm", "Add specification"]);
    const sha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await writeFile(join(source, "newer.txt"), "outside the pinned commit\n");
    execFileSync("git", ["-C", source, "add", "newer.txt"]);
    execFileSync("git", ["-C", source, "commit", "-qm", "Add later change"]);
    const fakeCodex = join(bin, "codex");
    await writeFile(fakeCodex, `#!/usr/bin/env node\nconst fs = require("node:fs");\nif (process.env.FAVA_DEVICE_TOKEN || fs.existsSync("newer.txt")) process.exit(8);\nfs.writeFileSync("outcome.txt", "implemented\\n");\nconst args = process.argv;\nfs.writeFileSync(args[args.indexOf("--output-last-message") + 1], "Added the outcome file.");\n`);
    await chmod(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${previous.PATH || ""}`;
    process.env.FAVA_DEVICE_TOKEN = `fava_dev_${"x".repeat(43)}`;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.file://${source}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = "https://github.com/owner/repo.git";
    const actions = [];
    const client = async body => { actions.push(body); return { status: "accepted" }; };
    client.origin = "https://fava.example";
    assert.deepEqual(await runClaim({ ...job, sha }, client), { submitted: true, runId: job.id });
    assert.deepEqual(actions.map(action => action.action), ["submit"]);
    assert.match(actions[0].patch, /\+implemented/);
    assert.match(actions[0].patch, /\+\+\+ b\/outcome\.txt/);
    assert.doesNotMatch(actions[0].patch, /newer\.txt|specs\/change\.md/);
    assert.equal(actions[0].summary, "Added the outcome file.");
  } finally {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(root, { recursive: true, force: true });
  }
});
