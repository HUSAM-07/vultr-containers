import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dataFile = process.env.FORGE_DATA_FILE || join(dirname(fileURLToPath(import.meta.url)), "data", "runs.json");
// ponytail: single-process JSON store; move to Convex plus a durable queue before multi-instance deployment.
const runs = load();
let active = 0;

function load() {
  try {
    return JSON.parse(readFileSync(dataFile, "utf8")).map(run =>
      run.status === "running" ? { ...run, status: "failed", error: "Backend restarted during execution" } : run);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
function save() {
  mkdirSync(dirname(dataFile), { recursive: true });
  writeFileSync(dataFile + ".tmp", JSON.stringify(runs));
  renameSync(dataFile + ".tmp", dataFile);
}
export function parsePlan(text) {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw Error("Model did not return JSON");
  const value = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(value.plan) || value.plan.length < 1 || value.plan.length > 6 ||
      !value.plan.every(x => typeof x === "string") || typeof value.code !== "string" ||
      !value.code || value.code.length > 20000) throw Error("Invalid agent plan");
  return { plan: value.plan, code: value.code };
}
export function parseArtifact(stdout) {
  const marker = "FORGE_ARTIFACT:";
  const lines = stdout.split("\n");
  const index = lines.findIndex(line => line.startsWith(marker));
  if (index < 0) return { stdout };
  const artifact = JSON.parse(lines[index].slice(marker.length));
  if (typeof artifact.html !== "string" || artifact.html.length > 40000 || !artifact.html.trim())
    throw Error("Invalid HTML artifact");
  lines.splice(index, 1);
  return { stdout: lines.join("\n"), artifact: artifact.html };
}
async function infer(messages) {
  const openrouter = process.env.INFERENCE_PROVIDER === "openrouter";
  const key = openrouter ? process.env.OPENROUTER_API_KEY : process.env.VULTR_INFERENCE_API_KEY;
  const model = openrouter ? "openai/gpt-6-luna" : process.env.VULTR_MODEL;
  if (!key || !model) throw Error((openrouter ? "OpenRouter" : "Vultr Serverless Inference") + " is not configured");
  const response = await fetch(openrouter
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.vultrinference.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 2600 }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw Error("Inference returned " + response.status);
  const value = (await response.json()).choices?.[0]?.message?.content;
  if (typeof value !== "string") throw Error("Inference returned no text");
  return value;
}
export function dockerArgs(name, code) {
  return ["run", "--rm", "--name", name, "--network", "none", "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m", "--memory", "256m", "--cpus", "1",
    "--pids-limit", "64", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "65534:65534", "python:3.12-alpine", "python", "-I", "-B", "-c", code];
}
function sandbox(code, id, attempt) {
  const name = "agent-" + id + "-" + attempt;
  return new Promise(resolve => {
    const child = spawn("docker", dockerArgs(name, code), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", finished = false, stoppedBy = "";
    const stop = reason => {
      if (stoppedBy) return;
      stoppedBy = reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("time"), 12000);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(0, 64000); if (stdout.length >= 64000) stop("output"); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(0, 64000); if (stderr.length >= 64000) stop("output"); });
    function done(exitCode, error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const result = { exitCode, stdout, stderr: error || stderr || (stoppedBy === "output" ? "Output exceeded 64 KB" : ""),
        timedOut: stoppedBy === "time" };
      if (!stoppedBy) return resolve(result);
      const cleanup = spawn("docker", ["rm", "-f", name]);
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(result); } };
      cleanup.on("error", finish);
      cleanup.on("close", finish);
      setTimeout(() => { cleanup.kill("SIGKILL"); finish(); }, 3000);
    }
    child.on("error", error => done(null, error.message));
    child.on("close", code => done(code));
  });
}
async function execute(run) {
  active++;
  run.status = "running";
  save();
  try {
    const system = "You are a product-building coding agent. Return ONLY JSON with plan (1-6 short steps) and code (Python 3.12 source). The code must do concrete, self-contained work and print verifiable output. For web page or UI tasks, build a single static HTML document with inline CSS, no external assets or scripts, and print one line starting FORGE_ARTIFACT: followed by JSON containing an html string. Print verification output on separate lines. Standard library only; no network or files. Do not claim execution happened.";
    let proposal = run.mode === "containment"
      ? { plan: ["Run an infinite loop inside an isolated container", "Verify the time limit stops it"], code: "while True: pass" }
      : parsePlan(await infer([{ role: "system", content: system }, { role: "user", content: run.task }]));
    run.plan = proposal.plan;
    for (let attempt = 1; attempt <= (run.mode === "containment" ? 1 : 2); attempt++) {
      run.code = proposal.code;
      const step = { name: attempt === 1 ? "sandbox.execute" : "sandbox.retry", status: "running", startedAt: Date.now() };
      run.steps.push(step);
      save();
      const result = await sandbox(proposal.code, run.id, attempt);
      Object.assign(step, { status: result.exitCode === 0 ? "success" : "error",
        result: result.timedOut ? "Stopped at 12 seconds" : (result.stderr || result.stdout).slice(0, 500),
        completedAt: Date.now() });
      run.output = result;
      if (result.exitCode === 0 && run.mode === "build") {
        const parsed = parseArtifact(result.stdout);
        run.output.stdout = parsed.stdout;
        run.artifact = parsed.artifact;
      }
      save();
      if (result.exitCode === 0 || run.mode === "containment" || attempt === 2) break;
      proposal = parsePlan(await infer([{ role: "system", content: system },
        { role: "user", content: run.task }, { role: "assistant", content: JSON.stringify(proposal) },
        { role: "user", content: "Execution failed. Fix code. stderr: " + result.stderr.slice(0, 3000) }]));
    }
    run.status = run.output.exitCode === 0 ? "succeeded" : "failed";
    run.summary = run.mode === "containment" && run.output.timedOut
      ? "Containment verified: the loop was stopped inside a network-disabled, resource-limited container."
      : run.status === "succeeded"
        ? "Executed successfully in the isolated sandbox. Review source and output."
        : "Execution failed. Review stderr and generated source.";
  } catch (error) {
    run.status = "failed";
    run.error = error.message;
  } finally {
    run.completedAt = Date.now();
    save();
    active--;
  }
}
async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10000) throw Error("Request too large");
  }
  return JSON.parse(body);
}
function send(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
function visibleRun(run) {
  const { ownerId, ...visible } = run;
  void ownerId;
  return visible;
}
export function app() {
  return createServer(async (request, response) => {
    if (request.url === "/health") return send(response, 200, { ok: true,
      configured: process.env.INFERENCE_PROVIDER === "openrouter"
        ? Boolean(process.env.OPENROUTER_API_KEY)
        : Boolean(process.env.VULTR_INFERENCE_API_KEY && process.env.VULTR_MODEL),
      provider: process.env.INFERENCE_PROVIDER === "openrouter" ? "OpenRouter · GPT-6 Luna" : "Vultr Serverless Inference",
      sandbox: "Docker" });
    if (!process.env.WEB_BACKEND_TOKEN ||
        request.headers.authorization !== "Bearer " + process.env.WEB_BACKEND_TOKEN)
      return send(response, 401, { error: "Unauthorized" });
    const ownerId = request.headers["x-session-id"];
    if (typeof ownerId !== "string" || !/^[a-f0-9-]{36}$/.test(ownerId))
      return send(response, 401, { error: "Missing session" });
    if (request.method === "GET" && request.url === "/runs")
      return send(response, 200, runs.filter(run => run.ownerId === ownerId)
        .map(run => {
          const { code, output, artifact, ...summary } = visibleRun(run);
          void code; void output; void artifact;
          return summary;
        }));
    if (request.method === "GET" && /^\/runs\/[a-f0-9-]+$/.test(request.url)) {
      const run = runs.find(item => item.id === request.url.slice(6) && item.ownerId === ownerId);
      if (!run) return send(response, 404, { error: "Run not found" });
      return send(response, 200, visibleRun(run));
    }
    if (request.method === "POST" && request.url === "/runs") {
      try {
        const { task, project = "General", mode = "build" } = await readJson(request);
        if (typeof task !== "string" || !task.trim() || task.length > 2000 ||
            typeof project !== "string" || !project.trim() || project.length > 80 ||
            !["build", "containment"].includes(mode))
          return send(response, 400, { error: "Invalid task or project" });
        const daily = runs.filter(run => Date.now() - run.createdAt < 86400000).length;
        if (active >= 2 || daily >= Number(process.env.MAX_RUNS_PER_DAY || 50))
          return send(response, 429, { error: "Demo capacity reached" });
        const run = { id: randomUUID(), ownerId, task: task.trim(), project: project.trim(), mode,
          status: "queued", plan: [], steps: [], createdAt: Date.now() };
        runs.unshift(run);
        save();
        void execute(run);
        return send(response, 202, visibleRun(run));
      } catch (error) { return send(response, 400, { error: error.message }); }
    }
    send(response, 404, { error: "Not found" });
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  app().listen(Number(process.env.PORT || 8080), process.env.HOST || "127.0.0.1");
