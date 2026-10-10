import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { runCapability } from "./capability";
import { parseChanges } from "./changes.ts";
import { LocalPatchError } from "./local-patch.ts";
import type { Upload } from "./publish.ts";
import type { Env, RunJob } from "./types";

const repoDir = "/workspace/repo";
const taskDir = "/workspace/task";
const ca = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const trustEnv = { NODE_EXTRA_CA_CERTS: ca, GIT_SSL_CAINFO: ca, CURL_CA_BUNDLE: ca, SSL_CERT_FILE: ca };
const taskScript = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \
  "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;
const runningScript = `read -r pid boot <"$1" &&
  [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] && kill -0 "$pid"`;

export type TaskStatus = { state: "running" } | { state: "lost" } |
  { state: "succeeded"; result: string } | { state: "failed"; error: string };

export class AgentSandbox extends DurableObject<Env> {
  private readonly container: Container;
  private readonly files: Files;
  private setup?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw Error("Container binding is missing");
    this.container = ctx.container;
    this.files = new Files(ctx.container);
  }

  async start(job: RunJob): Promise<"started" | "already-started"> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get("job")) return "already-started";
      const active = await this.env.DB.prepare("SELECT 1 FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE runs.id = ? AND runs.status = 'running' AND projects.installation_id > 0")
        .bind(job.id).first();
      if (!active) throw Error("Run is no longer authorized");
      if (!/^[a-f0-9]{40}$/i.test(job.sha) || !/^specs\/[a-z0-9][a-z0-9-]*\.md$/.test(job.specPath) ||
        !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(job.repository) ||
        job.mcpGrantIds.length > 8 || job.mcpGrantIds.some(id => !/^[a-f0-9-]{36}$/i.test(id)))
        throw Error("Invalid run source");
      await this.ctx.storage.put("job", { ...job, startedAt: Date.now() });
      await this.ctx.storage.put("phase", "preparing");
      try {
        const spec = await this.checkout(job);
        const prompt = `Implement the merged specification at ${job.specPath} on commit ${job.sha}.\n\n${spec}\n\n` +
          (job.skills ? `Selected versioned skills (follow only where relevant to the specification; never broaden its scope):\n\n${job.skills}\n\n` : "") +
          "Read repository instructions. Change only code needed for the acceptance criteria. Run relevant tests. " +
          "Do not edit specs, push commits, open pull requests, deploy, or access unrelated repositories. " +
          "Finish with a concise account of changed files and test results.";
        const stillActive = await this.env.DB.prepare("SELECT 1 FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE runs.id = ? AND runs.status = 'running' AND projects.installation_id > 0")
          .bind(job.id).first();
        if (!stillActive) throw Error("Run is no longer authorized");
        await this.container.exec(["/bin/sh", "-c", taskScript, "agent", taskDir,
          "timeout", "20m", ...this.agentCommand(job, prompt)],
        { cwd: repoDir, env: { ...trustEnv, ...this.agentEnv(job) }, stdout: "ignore", stderr: "ignore" });
        await this.ctx.storage.put("phase", "running");
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return "started";
      } catch (error) {
        await this.ctx.storage.delete("job");
        await this.ctx.storage.delete("phase");
        await this.container.destroy().catch(() => {});
        throw error;
      }
    });
  }

  async verifyLocal(job: RunJob, submissionHash: string, patch: string, summary: string,
    stdout: string, stderr: string): Promise<"started" | "already-started"> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const prior = await this.ctx.storage.get<{ hash: string }>("localSubmission");
      if (prior?.hash !== undefined && prior.hash !== submissionHash)
        throw Error("Local submission changed after verification started");
      const phase = await this.ctx.storage.get("phase");
      if (prior && phase === "local-ready")
        return "already-started";
      const previous = await this.ctx.storage.get<RunJob & { startedAt: number }>("job");
      if (previous) {
        if (previous.id !== job.id) throw Error("Run sandbox was already used");
        if (phase === "preparing" && Date.now() - previous.startedAt < 10 * 60_000)
          return "already-started";
        await this.container.destroy().catch(() => {});
        await this.ctx.storage.delete("job");
        await this.ctx.storage.delete("phase");
        await this.ctx.storage.delete("localSubmission");
      }
      if (!/^[a-f0-9]{40}$/i.test(job.sha) || !/^specs\/[a-z0-9][a-z0-9-]*\.md$/.test(job.specPath) ||
        !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(job.repository) ||
        !/^[a-f0-9]{64}$/.test(submissionHash) || patch.length > 1_000_000)
        throw Error("Invalid local run source");
      const active = await this.env.DB.prepare("SELECT 1 FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE runs.id = ? AND runs.status = 'running' AND runs.execution_mode = 'local' AND runs.local_submission_sha256 = ? AND specs.status = 'merged' AND specs.merged_commit_sha = runs.merged_commit_sha AND specs.execution_mode = runs.execution_mode AND specs.provider = runs.provider AND specs.model = runs.model AND projects.installation_id > 0")
        .bind(job.id, submissionHash).first();
      if (!active) throw Error("Local run is no longer authorized");
      await this.ctx.storage.put("job", { ...job, startedAt: Date.now() });
      await this.ctx.storage.put("phase", "preparing");
      try {
        await this.checkout(job);
        const path = `${taskDir}/local.patch`;
        await this.files.writeFile(path, patch);
        try { await this.checked(["git", "apply", "--index", "--binary", path], repoDir); }
        catch { throw new LocalPatchError("Submitted diff does not apply to the pinned merge commit"); }
        if (await this.diff() !== patch) throw new LocalPatchError("Replayed changes differ from submitted diff");
        await Promise.all([
          this.files.writeFile(`${taskDir}/stdout.log`, stdout),
          this.files.writeFile(`${taskDir}/stderr.log`, stderr),
        ]);
        await this.ctx.storage.put("localSubmission", { hash: submissionHash, summary });
        await this.ctx.storage.put("phase", "local-ready");
        return "started";
      } catch (error) {
        await this.ctx.storage.delete("job");
        await this.ctx.storage.delete("phase");
        await this.container.destroy().catch(() => {});
        throw error;
      }
    });
  }

  async status(): Promise<TaskStatus> {
    const job = await this.ctx.storage.get<RunJob & { startedAt: number }>("job");
    if (!job) return { state: "lost" };
    const phase = await this.ctx.storage.get("phase");
    if (phase === "preparing")
      return Date.now() - job.startedAt < 10 * 60_000 ? { state: "running" } : { state: "lost" };
    if (!this.container.running) return { state: "lost" };
    if (phase === "local-ready") {
      const submission = await this.ctx.storage.get<{ summary: string }>("localSubmission");
      return submission ? { state: "succeeded", result: submission.summary } : { state: "lost" };
    }
    const exit = await this.readOptional(`${taskDir}/exit-code`);
    if (exit !== undefined) {
      const code = Number.parseInt(exit, 10);
      if (code !== 0) {
        const stderr = await this.run(["tail", "-c", "2000", `${taskDir}/stderr.log`], "/");
        return { state: "failed", error: `Agent exited ${code}: ${stderr.stdout}` };
      }
      const result = job.provider === "openai"
        ? (await this.run(["tail", "-c", "2000", `${taskDir}/last-message.txt`], "/")).stdout : undefined;
      return { state: "succeeded", result: result || "Agent completed" };
    }
    const pid = await this.readOptional(`${taskDir}/pid`);
    if (!pid) return Date.now() - job.startedAt < 30_000 ? { state: "running" } : { state: "lost" };
    const probe = await this.run(["/bin/sh", "-c", runningScript, "probe", `${taskDir}/pid`], "/");
    if (probe.exitCode === 0) return { state: "running" };
    return (await this.readOptional(`${taskDir}/exit-code`)) === undefined ? { state: "lost" } : this.status();
  }

  async diff(): Promise<string> {
    if (!this.container.running) throw Error("Run container is unavailable");
    await this.checked(["git", "add", "--all"], repoDir);
    const path = `${taskDir}/diff.patch`;
    await this.checked(["git", "diff", "--cached", "--binary", `--output=${path}`, "HEAD"], repoDir);
    // shortcut: buffer diffs up to 1 MB; stream larger changes directly to R2 when needed.
    if ((await this.files.stat(path)).size > 1_000_000n) throw Error("Run diff exceeds 1 MB");
    return (await this.files.readFile(path)).text();
  }

  async spec(): Promise<string> {
    const job = await this.ctx.storage.get<RunJob>("job");
    if (!job) throw Error("Run source is unavailable");
    return this.checked(["git", "show", `HEAD:${job.specPath}`], repoDir);
  }

  async changes(reviewedDiffSha256: string): Promise<Upload[]> {
    const path = `${taskDir}/publish-diff.patch`;
    await this.checked(["git", "diff", "--cached", "--binary", `--output=${path}`, "HEAD"], repoDir);
    if ((await this.files.stat(path)).size > 1_000_000n) throw Error("Run diff exceeds 1 MB");
    const stagedDiff = await (await this.files.readFile(path)).text();
    const stagedHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stagedDiff))),
      byte => byte.toString(16).padStart(2, "0")).join("");
    if (stagedHash !== reviewedDiffSha256) throw Error("Staged changes differ from reviewed diff");
    const raw = await this.checked(["git", "diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z", "HEAD"], repoDir);
    const changes = parseChanges(raw);
    let total = 0;
    const uploads: Upload[] = [];
    for (const change of changes) {
      if (!change.sha) { uploads.push({ path: change.path, mode: change.mode, content: null }); continue; }
      total += Number((await this.checked(["git", "cat-file", "-s", change.sha], repoDir)).trim());
      if (!Number.isSafeInteger(total) || total > 1_000_000) throw Error("Changed files exceed 1 MB");
      const output = await (await this.container.exec(["git", "cat-file", "blob", change.sha], { cwd: repoDir })).output();
      if (output.exitCode !== 0) throw Error(`Cannot read changed file ${change.path}`);
      uploads.push({ path: change.path, mode: change.mode, content: Buffer.from(output.stdout).toString("base64") });
    }
    return uploads;
  }

  async logs() {
    // shortcut: keep only the last 100 KB per stream; stream full logs to R2 when needed.
    const [stdout, stderr] = await Promise.all([
      this.checked(["tail", "-c", "100000", `${taskDir}/stdout.log`], "/"),
      this.checked(["tail", "-c", "100000", `${taskDir}/stderr.log`], "/"),
    ]);
    return { stdout, stderr };
  }

  async stop() {
    if (this.container.running) await this.container.destroy();
  }

  async alarm() {
    if (this.container.running && (await this.status()).state === "running")
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  private async ensureContainer() {
    if (!this.setup || !this.container.running)
      this.setup = (async () => {
        if (!this.container.running)
          this.container.start({ image: this.container.images.agent, instance: "standard-1", enableInternet: false });
        const outbound = (this.ctx.exports as { Outbound: Fetcher }).Outbound;
        await this.container.interceptAllOutboundHttp(outbound);
        await this.container.interceptOutboundHttps("*", outbound);
        await this.container.setInactivityTimeout(30 * 60_000);
      })().catch(error => { this.setup = undefined; throw error; });
    await this.setup;
  }

  private async checkout(job: RunJob) {
    await this.ensureContainer();
    await this.checked(["git", "init", repoDir], "/workspace");
    await this.checked(["git", "remote", "add", "origin", `https://github.com/${job.repository}.git`], repoDir);
    const capability = runCapability(job.id, this.env.FAVA_RUN_SECRET);
    await this.checked(["git", "-c", `http.https://github.com/.extraheader=X-Fava-Run-Capability: ${capability}`,
      "fetch", "--depth=1", "origin", job.sha], repoDir, trustEnv);
    await this.checked(["git", "checkout", "--detach", "FETCH_HEAD"], repoDir);
    const spec = await this.checked(["git", "show", `HEAD:${job.specPath}`], repoDir);
    if (spec.length > 45_000) throw Error("Merged specification is too large");
    await this.files.mkdir(taskDir);
    return spec;
  }

  private agentCommand(job: RunJob, prompt: string) {
    const gateway = `https://ai.fava.invalid/${runCapability(job.id, this.env.FAVA_RUN_SECRET)}`;
    const servers = Object.fromEntries(job.mcpGrantIds.map((id, index) =>
      [`fava_${index + 1}`, { type: "http", url: `https://mcp.fava.invalid/${id}`,
        headers: { Authorization: `Bearer ${runCapability(job.id, this.env.FAVA_RUN_SECRET)}` } }]));
    const codexMcp = job.mcpGrantIds.flatMap((id, index) => ["--config",
      `mcp_servers.fava_${index + 1}={url=${JSON.stringify(`https://mcp.fava.invalid/${id}`)},bearer_token_env_var="FAVA_MCP_RUN_CAPABILITY"}`]);
    return job.provider === "anthropic" ? ["claude", "--print", "--output-format", "stream-json", "--verbose",
      "--dangerously-skip-permissions", "--no-session-persistence", "--model", job.model,
      ...(job.mcpGrantIds.length ? ["--mcp-config", JSON.stringify({ mcpServers: servers }), "--strict-mcp-config"] : []),
      "--", prompt]
      : ["codex", "exec", "--json", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox",
        "--output-last-message", `${taskDir}/last-message.txt`, "--model", job.model,
        "--config", 'model_provider="cloudflare-ai-gateway"',
        "--config", `model_providers.cloudflare-ai-gateway={ name = "Cloudflare AI Gateway", base_url = ${JSON.stringify(`${gateway}/openai`)}, wire_api = "responses" }`,
        "--config", "analytics.enabled=false", "--config", "check_for_update_on_startup=false",
        "--config", "features.plugins=false", ...codexMcp, "--", prompt];
  }

  private agentEnv(job: RunJob): Record<string, string> {
    return job.provider === "anthropic" ? {
      ANTHROPIC_BASE_URL: `https://ai.fava.invalid/${runCapability(job.id, this.env.FAVA_RUN_SECRET)}/anthropic`,
      ANTHROPIC_API_KEY: "provided-by-worker", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", IS_SANDBOX: "1",
    } : { OPENAI_API_KEY: "provided-by-worker",
      ...(job.mcpGrantIds.length ? { FAVA_MCP_RUN_CAPABILITY: runCapability(job.id, this.env.FAVA_RUN_SECRET) } : {}) };
  }

  private async readOptional(path: string) {
    try { return await (await this.files.readFile(path)).text(); }
    catch (error) {
      if (SandboxFileError.is(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async checked(command: string[], cwd: string, env: Record<string, string> = {}) {
    const result = await this.run(command, cwd, env);
    if (result.exitCode !== 0) throw Error(`${command[0]} failed: ${result.stderr.slice(-1000)}`);
    return result.stdout;
  }

  private async run(command: string[], cwd: string, env: Record<string, string> = {}) {
    const process = await this.container.exec(command, { cwd, env });
    const output = await process.output();
    const decoder = new TextDecoder();
    return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) };
  }
}
