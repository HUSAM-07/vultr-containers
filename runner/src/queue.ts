import { chooseModel } from "../../web/lib/fava-models.ts";
import { publishImplementation } from "./publish.ts";
import { loadRunSkills } from "./skills.ts";
import { parseConformanceReport, ReviewError, reviewConformance } from "./conformance.ts";
import type { AgentSandbox } from "./sandbox";
import type { Env, RunJob } from "./types";

type RunRow = { id: string; repository: string; repositoryId: number; installationId: number;
  sha: string; specPath: string; provider: string; model: string };
type RunningRow = RunRow & { startedAt: number; defaultBranch: string; specPullNumber: number };

async function queued(env: Env) {
  const result = await env.DB.prepare("SELECT runs.id, runs.merged_commit_sha AS sha, runs.provider, runs.model, specs.path AS specPath, projects.full_name AS repository, projects.github_repo_id AS repositoryId, projects.installation_id AS installationId FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE runs.status = 'queued' AND specs.status = 'merged' AND specs.merged_commit_sha = runs.merged_commit_sha ORDER BY runs.created_at LIMIT 3")
    .all<RunRow>();
  return result.results;
}

async function running(env: Env) {
  const result = await env.DB.prepare("SELECT runs.id, COALESCE(runs.started_at, runs.created_at) AS startedAt, runs.merged_commit_sha AS sha, runs.provider, runs.model, specs.path AS specPath, specs.pull_number AS specPullNumber, projects.full_name AS repository, projects.github_repo_id AS repositoryId, projects.installation_id AS installationId, projects.default_branch AS defaultBranch FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE runs.status = 'running' ORDER BY runs.created_at LIMIT 10")
    .all<RunningRow>();
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
  for (const run of await running(env)) {
    const { id, startedAt } = run;
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
      const diffHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(diff))),
        byte => byte.toString(16).padStart(2, "0")).join("");
      let review;
      try {
        const savedReview = await env.ARTIFACTS.get(`${prefix}/review.json`);
        let cached: { diffSha256?: string } | null = null;
        if (savedReview) {
          try {
            const parsed = JSON.parse(await savedReview.text());
            if (!parsed || typeof parsed !== "object") throw Error("Invalid report");
            cached = parsed as { diffSha256?: string };
          }
          catch { throw new ReviewError("Saved spec review is invalid"); }
        }
        if (cached && cached.diffSha256 !== diffHash) throw new ReviewError("Spec review source changed after the first review");
        review = cached ? parseConformanceReport(cached) : await reviewConformance(env, run, await sandbox.spec(), diff);
        if (!cached) await env.ARTIFACTS.put(`${prefix}/review.json`, JSON.stringify({ ...review, diffSha256: diffHash }),
          { httpMetadata: { contentType: "application/json; charset=utf-8" } });
      } catch (error) {
        if (!(error instanceof ReviewError)) throw error;
        await fail(env, id, `Spec review could not run: ${error.message}`, prefix);
        continue;
      }
      if (!review.pass) {
        await fail(env, id, `Spec review rejected changes: ${[...review.unmet, ...review.unrelated].join("; ") || "insufficient evidence"}`, prefix);
        continue;
      }
      const published = await publishImplementation(env, run, await sandbox.changes(), status.result);
      await env.DB.prepare("UPDATE runs SET status = 'succeeded', summary = ?, artifact_key = ?, implementation_branch = ?, pull_number = ?, completed_at = ? WHERE id = ? AND status = 'running'")
        .bind(status.result.slice(0, 2000), prefix, published.branch, published.pullNumber, Date.now(), id).run();
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
    let skills: string;
    try { skills = await loadRunSkills(env, row.id); }
    catch (error) {
      await fail(env, row.id, `Pinned skills could not be loaded: ${error instanceof Error ? error.message : "unknown error"}`);
      continue;
    }
    const job: RunJob = { id: row.id, repository: row.repository, repositoryId: row.repositoryId,
      installationId: row.installationId, sha: row.sha, specPath: row.specPath,
      provider: model.provider, model: model.model, skills };
    try { await env.SANDBOX.getByName(row.id).start(job); }
    catch (error) { console.error("Run dispatch outcome is unknown; reconciliation will inspect it", row.id, error); }
  }
}
