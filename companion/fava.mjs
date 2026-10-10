#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const heartbeatMs = 20_000;
const maxRunMs = 40 * 60_000;
const tokenPattern = /^fava_dev_[A-Za-z0-9_-]{43}$/;

export function serverOrigin(value) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw Error("FAVA_URL must be an HTTPS origin, or a loopback HTTP origin for development");
  return url.origin;
}

export function validateJob(value) {
  if (!value || typeof value !== "object" ||
    !/^[a-f0-9-]{36}$/i.test(value.id) || !/^[a-f0-9-]{36}$/i.test(value.leaseId) ||
    !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value.repository) ||
    !/^[a-f0-9]{40}$/i.test(value.sha) || !/^specs\/[a-z0-9][a-z0-9-]*\.md$/.test(value.specPath) ||
    !((value.provider === "openai" && value.model === "gpt-6-sol") ||
      (value.provider === "anthropic" && value.model === "claude-sonnet-5")) ||
    !Number.isSafeInteger(value.pinnedSkills) || !Number.isSafeInteger(value.pinnedMcpGrants))
    throw Error("Fava returned an invalid local run");
  return value;
}

export function agentEnvironment(source = process.env) {
  const environment = { ...source };
  for (const name of ["FAVA_DEVICE_TOKEN", "FAVA_URL", "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"])
    delete environment[name];
  return environment;
}

export async function runProcess(command, args, options = {}) {
  const { cwd, input, signal, timeout = 120_000, maxOutput = 100_000, env = agentEnvironment() } = options;
  if (signal?.aborted) throw signal.reason || Error("Run cancelled");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let hardStop;
    const keep = (prior, chunk) => {
      const joined = Buffer.concat([prior, chunk]);
      if (joined.byteLength > maxOutput) truncated = true;
      return joined.subarray(Math.max(0, joined.byteLength - maxOutput));
    };
    child.stdout.on("data", chunk => { stdout = keep(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = keep(stderr, chunk); });
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); }
      catch { child.kill("SIGTERM"); }
      hardStop = setTimeout(() => {
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }, 5_000);
      hardStop.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.once("error", error => {
      clearTimeout(timer);
      clearTimeout(hardStop);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timer);
      clearTimeout(hardStop);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason || Error("Run cancelled"));
      else if (timedOut) reject(Error(`${command} exceeded its time limit`));
      else resolve({ code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated });
    });
  });
}

export function createClient(origin, token, fetcher = fetch) {
  const url = `${serverOrigin(origin)}/api/devices/runs`;
  if (!tokenPattern.test(token)) throw Error("FAVA_DEVICE_TOKEN is invalid");
  return async (body, signal) => {
    const response = await fetcher(url, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30_000)]) });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const error = Error(`Fava ${response.status}: ${typeof value?.error === "string" ? value.error : "request failed"}`);
      error.status = response.status;
      throw error;
    }
    return value;
  };
}

function requireSuccess(result, command) {
  if (result.code !== 0 || result.truncated) throw Error(`${command} failed: ${result.stderr.slice(-500)}`);
  return result.stdout;
}

function summaryFrom(provider, stdout, lastMessage) {
  if (provider === "openai" && lastMessage.trim()) return lastMessage.trim().slice(0, 2_000);
  if (provider === "anthropic") {
    for (const line of stdout.split("\n").reverse()) {
      try { const event = JSON.parse(line); if (event.type === "result" && typeof event.result === "string")
        return event.result.trim().slice(0, 2_000); } catch { /* bounded log can start mid-event */ }
    }
  }
  return "Agent completed; inspect its log for details.";
}

export async function runClaim(rawJob, client, externalSignal) {
  const job = validateJob(rawJob);
  const controller = new AbortController();
  const directory = await mkdtemp(join(tmpdir(), "fava-run-"));
  const onAbort = () => controller.abort(externalSignal.reason || Error("Companion stopped"));
  externalSignal?.addEventListener("abort", onAbort, { once: true });
  if (externalSignal?.aborted) onAbort();
  const repo = join(directory, "repo");
  const summaryFile = join(directory, "last-message.txt");
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(() => client({ action: "heartbeat", runId: job.id, leaseId: job.leaseId }, controller.signal))
      .catch(error => controller.abort(error));
  }, heartbeatMs);
  const git = async (...args) => requireSuccess(await runProcess("git", args, { cwd: repo, signal: controller.signal }), "git");
  try {
    controller.signal.throwIfAborted();
    // shortcut: pinned skills and MCP need an isolated allowlisted mount before this client can execute them.
    if (job.pinnedSkills || job.pinnedMcpGrants)
      throw Error("This companion does not yet support pinned skills or MCP grants");
    await mkdir(repo);
    await git("init", "-q");
    await git("remote", "add", "origin", `https://github.com/${job.repository}.git`);
    await git("fetch", "--depth=1", "origin", job.sha);
    await git("checkout", "--detach", "-q", "FETCH_HEAD");
    if ((await git("rev-parse", "HEAD")).trim().toLowerCase() !== job.sha.toLowerCase())
      throw Error("Git checkout did not match the merged specification commit");
    const spec = await git("show", `HEAD:${job.specPath}`);
    if (Buffer.byteLength(spec) > 45_000) throw Error("Merged specification is too large");
    const prompt = `Implement the merged specification at ${job.specPath} on commit ${job.sha}.\n\n${spec}\n\n` +
      "Change only code needed for its acceptance criteria. Do not edit specs or instruction files, push commits, " +
      "open pull requests, deploy, or access unrelated repositories. Finish with a concise account of changed files and test results.";
    const args = job.provider === "openai"
      ? ["exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "--approve-for-me", "--model", job.model,
        "--output-last-message", summaryFile, "-"]
      : ["--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
        "--permission-mode", "acceptEdits", "--model", job.model];
    const result = await runProcess(job.provider === "openai" ? "codex" : "claude", args,
      { cwd: repo, input: prompt, signal: controller.signal, timeout: maxRunMs });
    if (result.code !== 0) throw Error(`${job.provider} exited ${result.code}: ${result.stderr.slice(-500)}`);
    await git("add", "-A");
    const names = (await git("diff", "--cached", "--name-only", "-z", "HEAD")).split("\0").filter(Boolean);
    if (!names.length || names.length > 25 || names.some(path => path.startsWith("specs/") ||
      path.startsWith(".fava/skills/") || ["AGENTS.md", "CLAUDE.md"].includes(path.split("/").at(-1)) ||
      /(^|\/)\.env($|\.)|\.(pem|key)$/i.test(path)))
      throw Error("Agent changed no files, too many files, or a protected file");
    const diff = await runProcess("git", ["diff", "--cached", "--binary", "HEAD"],
      { cwd: repo, signal: controller.signal, maxOutput: 1_000_001 });
    const patch = requireSuccess(diff, "git diff");
    if (Buffer.byteLength(patch) > 1_000_000) throw Error("Agent diff exceeds 1 MB");
    clearInterval(timer);
    await heartbeat;
    if (controller.signal.aborted) throw controller.signal.reason;
    const lastMessage = await readFile(summaryFile, "utf8").catch(() => "");
    await client({ action: "submit", runId: job.id, leaseId: job.leaseId, patch,
      summary: summaryFrom(job.provider, result.stdout, lastMessage),
      stdout: result.stdout, stderr: result.stderr }, controller.signal);
    return { submitted: true, runId: job.id };
  } catch (error) {
    if (!controller.signal.aborted)
      await client({ action: "fail", runId: job.id, leaseId: job.leaseId,
        message: String(error instanceof Error ? error.message : error).slice(0, 1_000) }).catch(() => {});
    throw error;
  } finally {
    clearInterval(timer);
    controller.abort(Error("Run finished"));
    externalSignal?.removeEventListener("abort", onAbort);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function main() {
  const client = createClient(process.env.FAVA_URL || "", process.env.FAVA_DEVICE_TOKEN || "");
  const once = process.argv.includes("--once");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(Error("Companion stopped")));
  process.once("SIGTERM", () => controller.abort(Error("Companion stopped")));
  const pause = () => new Promise(resolve => {
    const abort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, 15_000);
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  while (!controller.signal.aborted) {
    try {
      const claim = await client({ action: "claim" }, controller.signal);
      if (claim?.pending) {
        if (once) { console.log("No queued local run"); return; }
        await pause();
        continue;
      }
      const result = await runClaim(claim, client, controller.signal);
      console.log(`Submitted local run ${result.runId}`);
      if (once) return;
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(error instanceof Error ? error.message : String(error));
      if (once || error?.status === 401) throw error;
      await pause();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
