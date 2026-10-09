import { cloudflare, cloudflareToken, type CloudflareConnection, type PreviewBuild } from "./fava-cloudflare.ts";
import type { env } from "./runtime-env.ts";

type RunPreview = { id: string; status: string; pullNumber: number | null; previewUrl: string | null;
  implementationSha: string | null; completedAt: number | null };

export async function refreshRunPreviews(db: typeof env.DB, accountId: string, projectId: string,
  runs: RunPreview[], force = false) {
  const pending = runs.filter(run => run.status === "succeeded" && run.pullNumber && !run.previewUrl &&
    /^[a-f0-9]{40}$/i.test(run.implementationSha || "") &&
    (force || run.completedAt && Date.now() - run.completedAt < 60 * 60_000));
  if (!pending.length) return;
  const connection = await db.prepare("SELECT cloudflare_connections.*, cloudflare_project_previews.worker_tag AS workerTag, cloudflare_project_previews.trigger_uuid AS triggerUuid FROM cloudflare_project_previews JOIN cloudflare_connections ON cloudflare_connections.account_id = cloudflare_project_previews.account_id WHERE cloudflare_project_previews.project_id = ? AND cloudflare_project_previews.account_id = ?")
    .bind(projectId, accountId).first<CloudflareConnection & { workerTag: string; triggerUuid: string }>();
  if (!connection) return;
  const token = await cloudflareToken(db, connection);
  const builds = await cloudflare<PreviewBuild[]>(token,
    `/accounts/${connection.cloudflare_account_id}/builds/workers/${connection.workerTag}/builds?per_page=100`);
  builds.sort((a, b) => (b.created_on || "").localeCompare(a.created_on || ""));
  for (const run of pending) {
    const build = builds.find(item => item.trigger?.trigger_uuid === connection.triggerUuid &&
      item.build_outcome === "success" && item.build_trigger_metadata?.branch === `impl/${run.id}` &&
      typeof item.build_trigger_metadata.commit_hash === "string" &&
      item.build_trigger_metadata.commit_hash.length >= 12 &&
      run.implementationSha!.startsWith(item.build_trigger_metadata.commit_hash));
    if (!build) continue;
    const detail = await cloudflare<PreviewBuild>(token,
      `/accounts/${connection.cloudflare_account_id}/builds/builds/${build.build_uuid}`);
    if (!detail.preview_url?.startsWith("https://")) continue;
    const saved = await db.prepare("UPDATE runs SET preview_url = ? WHERE id = ? AND implementation_sha = ? AND status = 'succeeded' AND preview_url IS NULL AND spec_id IN (SELECT id FROM specs WHERE project_id = ?)")
      .bind(detail.preview_url, run.id, run.implementationSha, projectId).run();
    if (saved.meta.changes === 1) run.previewUrl = detail.preview_url;
  }
}
