import { chooseModel } from "../../web/lib/fava-models.ts";
import type { AgentSandbox } from "./sandbox";
import type { Env, RunJob } from "./types";

type RunRow = { id: string; repository: string; repositoryId: number; installationId: number;
  sha: string; specPath: string; provider: string; model: string };

async function queued(env: Env) {
  const result = await env.DB.prepare("SELECT runs.id, runs.merged_commit_sha AS sha, runs.provider, runs.model, specs.path AS specPath, projects.full_name AS repository, projects.github_repo_id AS repositoryId, projects.installation_id AS installationId FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE runs.status = 'queued' AND specs.status = 'merged' AND specs.merged_commit_sha = runs.merged_commit_sha ORDER BY runs.created_at LIMIT 3")
    .all<RunRow>();
  return result.results;
}

async function running(env: Env) {
  const result = await env.DB.prepare("SELECT id, COALESCE(started_at, created_at) AS startedAt FROM runs WHERE status = 'running' ORDER BY created_at LIMIT 10")
    .all<{ id: string; startedAt: number | null }>();
  return result.results;
}

async function fail(env: Env, id: string, error: string, artifactKey: string | null = null) {
  await env.DB.prepare("UPDATE runs SET status = 'failed', error = ?, artifact_key = ?, completed_at = ? WHERE id = ? AND status = 'running'")
    .bind(error.slice(0, 2000), artifactKey, Date.now(), id).run();
}

async function saveLogs(env: Env, id: string, sandbox: DurableObjectStub<AgentSandbox>) {
  const { stdout, stderr } = await sandbox.logs();
  const prefix = `runs/${id}`;
  await Promise.all([
    env.ARTIFACTS.put(`${prefix}/stdout.log`, stdout, { httpMetadata: { contentType: "text/plain; charset=utf-8" } }),
    env.ARTIFACTS.put(`${prefix}/stderr.log`, stderr, { httpMetadata: { contentType: "text/plain; charset=utf-8" } }),
  ]);
  return prefix;
}

export async function reconcile(env: Env) {
  for (const { id, startedAt } of await running(env)) {
    const sandbox = env.SANDBOX.getByName(id);
    try {
      const status = await sandbox.status();
      if (status.state === "running") {
        if (startedAt && Date.now() - startedAt > 45 * 60_000) {
          await fail(env, id, "Agent exceeded the 45-minute run limit");
          await sandbox.stop();
        }
        continue;
      }
      if (status.state === "lost") { await fail(env, id, "Agent container stopped before producing a result"); continue; }
      const prefix = await saveLogs(env, id, sandbox);
      if (status.state === "failed") { await fail(env, id, status.error, prefix); continue; }
      const diff = await sandbox.diff();
      if (!diff.trim()) { await fail(env, id, "Agent completed without code changes", prefix); continue; }
      await env.ARTIFACTS.put(`${prefix}/diff.patch`, diff, { httpMetadata: { contentType: "text/x-diff; charset=utf-8" } });
      await env.DB.prepare("UPDATE runs SET status = 'succeeded', summary = ?, artifact_key = ?, completed_at = ? WHERE id = ? AND status = 'running'")
        .bind(status.result.slice(0, 2000), prefix, Date.now(), id).run();
    } catch (error) {
      console.error("Run reconciliation failed", id, error);
      if (startedAt && Date.now() - startedAt > 45 * 60_000)
        await fail(env, id, "Runner could not recover within 45 minutes");
    }
  }
}

export async function dispatch(env: Env) {
  if (!env.AI_GATEWAY_TOKEN || !env.GITHUB_APP_PRIVATE_KEY || !env.FAVA_RUN_SECRET) return;
  for (const row of await queued(env)) {
    let model: ReturnType<typeof chooseModel>;
    try { model = chooseModel(row.model); }
    catch { continue; }
    if (model.provider !== row.provider) continue;
    const claimed = await env.DB.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
      .bind(Date.now(), row.id).run();
    if (claimed.meta.changes !== 1) continue;
    const job: RunJob = { id: row.id, repository: row.repository, repositoryId: row.repositoryId,
      installationId: row.installationId, sha: row.sha, specPath: row.specPath,
      provider: model.provider, model: model.model };
    try { await env.SANDBOX.getByName(row.id).start(job); }
    catch (error) { console.error("Run dispatch outcome is unknown; reconciliation will inspect it", row.id, error); }
  }
}
