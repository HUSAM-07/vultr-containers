import { createHmac, sign, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { github, parseRepo, validateSpec, GitHubError } from "./fava-github.ts";
import type { env } from "./runtime-env.ts";

type Db = typeof env.DB;
type PullEvent = {
  action?: string;
  installation?: { id: number };
  repository?: { id: number; full_name: string };
  pull_request?: { number: number; merged: boolean; merge_commit_sha: string | null;
    head: { ref: string }; base: { ref: string } };
};
type TrackedSpec = { id: string; path: string; branch: string; status: string;
  mergedSha: string | null; defaultBranch: string; provider: string | null; model: string | null;
  projectId: string; accountId: string; executionMode: "cloud" | "local" };

export function verifyWebhookSignature(secret: string, body: Uint8Array, signature: string | null) {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

export async function processAuthorizationRevocation(db: Db, payload: unknown) {
  if (!payload || typeof payload !== "object") throw new GitHubError(400, "Invalid authorization webhook");
  const event = payload as { action?: unknown; sender?: { id?: unknown } };
  const userId = event.sender?.id;
  if (event.action !== "revoked" || typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0)
    throw new GitHubError(400, "Invalid authorization webhook");
  await db.prepare("UPDATE sessions SET revoked_at = ? WHERE github_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), userId).run();
  return { revoked: true };
}

export async function processInstallationLoss(db: Db, payload: unknown,
  eventName: "installation" | "installation_repositories", deliveryId: string) {
  if (!payload || typeof payload !== "object" || !/^[a-z0-9-]{1,100}$/i.test(deliveryId))
    throw new GitHubError(400, "Invalid installation webhook");
  const event = payload as { action?: unknown; installation?: { id?: unknown };
    repositories_removed?: { id?: unknown }[] };
  if (eventName === "installation" && !["deleted", "suspend"].includes(String(event.action)) ||
    eventName === "installation_repositories" && event.action !== "removed") return { disconnected: false };
  const installationId = event.installation?.id;
  if (typeof installationId !== "number" || !Number.isSafeInteger(installationId) || installationId <= 0)
    throw new GitHubError(400, "Invalid installation webhook");
  const removed = eventName === "installation_repositories" ? event.repositories_removed : null;
  if (eventName === "installation_repositories" && (!Array.isArray(removed) ||
    removed.some(repo => !repo || !Number.isSafeInteger(repo.id) || (repo.id as number) <= 0)))
    throw new GitHubError(400, "Invalid installation webhook");
  const prior = await db.prepare("SELECT processed_at AS processedAt FROM webhook_deliveries WHERE delivery_id = ?")
    .bind(deliveryId).first<{ processedAt: number | null }>();
  if (prior?.processedAt) return { disconnected: true, duplicate: true };
  const now = Date.now();
  await db.prepare("INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event_name, received_at) VALUES (?, ?, ?)")
    .bind(deliveryId, eventName, now).run();
  // GitHub sends an empty removal list when installation access changes from all to selected.
  const repositoryIds = removed?.length ? removed.map(repo => repo.id as number) : [null];
  await db.batch([
    ...repositoryIds.map(repoId => db.prepare("UPDATE runs SET status = 'cancelled', error = 'GitHub installation access removed', completed_at = ? WHERE status IN ('queued', 'running') AND spec_id IN (SELECT specs.id FROM specs JOIN projects ON projects.id = specs.project_id WHERE projects.installation_id = ? AND (? IS NULL OR projects.github_repo_id = ?))")
      .bind(now, installationId, repoId, repoId)),
    ...repositoryIds.map(repoId => db.prepare("UPDATE projects SET installation_id = 0 WHERE installation_id = ? AND (? IS NULL OR github_repo_id = ?)")
      .bind(installationId, repoId, repoId)),
    db.prepare("UPDATE webhook_deliveries SET processed_at = ? WHERE delivery_id = ?")
      .bind(now, deliveryId),
  ]);
  return { disconnected: true };
}

export function appJwt(clientId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

export async function requireWebhookReady(clientId?: string, privateKey?: string) {
  if (!clientId || !privateKey) throw new GitHubError(503, "Fava GitHub App credentials are not configured");
  let app: { events?: string[] };
  let hook: { url?: string; content_type?: string; insecure_ssl?: string | number; secret?: string };
  try {
    const jwt = appJwt(clientId, privateKey);
    [app, hook] = await Promise.all([
      github<{ events?: string[] }>(jwt, "/app"),
      github<{ url?: string; content_type?: string; insecure_ssl?: string | number; secret?: string }>(jwt, "/app/hook/config"),
    ]);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404)
      throw new GitHubError(503, "Fava GitHub App webhook is not ready for merged specifications");
    throw new GitHubError(503, "Fava cannot verify its GitHub App webhook settings");
  }
  if (!app.events?.includes("pull_request") || !app.events.includes("github_app_authorization") ||
    !hook.url?.startsWith("https://") || !hook.url.endsWith("/api/github/webhook") ||
    hook.content_type !== "json" || String(hook.insecure_ssl) !== "0" || !hook.secret)
    throw new GitHubError(503, "Fava GitHub App webhook is not ready for merged specifications");
}

export async function processPullRequestEvent(db: Db, payload: unknown, deliveryId: string,
  credentials: { clientId?: string; privateKey?: string }) {
  if (!payload || typeof payload !== "object") throw new GitHubError(400, "Invalid pull request webhook");
  const event = payload as PullEvent;
  if (event.action !== "closed") return { recorded: false };
  const repo = event.repository;
  const installation = event.installation;
  const pull = event.pull_request;
  if (!repo || !Number.isSafeInteger(repo.id) || typeof repo.full_name !== "string" ||
    !installation || !Number.isSafeInteger(installation.id) ||
    !pull || !Number.isSafeInteger(pull.number) || typeof pull.merged !== "boolean" ||
    typeof pull.head?.ref !== "string" || typeof pull.base?.ref !== "string")
    throw new GitHubError(400, "Invalid pull request webhook");
  const name = parseRepo(repo.full_name);
  const tracked = await db.prepare("SELECT specs.id, specs.path, specs.branch, specs.status, specs.merged_commit_sha AS mergedSha, specs.provider, specs.model, specs.execution_mode AS executionMode, projects.id AS projectId, projects.account_id AS accountId, projects.default_branch AS defaultBranch FROM specs JOIN projects ON projects.id = specs.project_id WHERE projects.github_repo_id = ? AND projects.installation_id = ? AND specs.pull_number = ?")
    .bind(repo.id, installation.id, pull.number)
    .all<TrackedSpec>();
  const specs = (tracked.results as TrackedSpec[]).filter(spec => spec.branch === pull.head.ref && spec.defaultBranch === pull.base.ref);
  if (!specs.length) return { recorded: false };
  const prior = await db.prepare("SELECT processed_at AS processedAt FROM webhook_deliveries WHERE delivery_id = ?")
    .bind(deliveryId).first<{ processedAt: number | null }>();
  if (prior?.processedAt) return { recorded: true, duplicate: true };
  await db.prepare("INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event_name, received_at) VALUES (?, 'pull_request', ?)")
    .bind(deliveryId, Date.now()).run();

  if (!pull.merged) {
    await db.batch([
      ...specs.map(spec => db.prepare("UPDATE specs SET status = 'closed' WHERE id = ? AND status = 'open'").bind(spec.id)),
      db.prepare("UPDATE webhook_deliveries SET processed_at = ? WHERE delivery_id = ?").bind(Date.now(), deliveryId),
    ]);
    return { recorded: true, status: "closed" };
  }
  if (!credentials.clientId || !credentials.privateKey) throw new GitHubError(503, "GitHub App private key is not configured");
  if (!/^[a-f0-9]{40}$/i.test(pull.merge_commit_sha || ""))
    throw new GitHubError(422, "Merged specification PR has no valid commit");
  const installationToken = await github<{ token: string }>(appJwt(credentials.clientId, credentials.privateKey),
    `/app/installations/${installation.id}/access_tokens`, "POST",
    { repository_ids: [repo.id], permissions: { contents: "read", pull_requests: "read" } });
  const files = await github<{ filename: string; status: string }[]>(installationToken.token,
    `/repos/${name}/pulls/${pull.number}/files?per_page=100`);
  if (files.length !== 1 || files[0].status !== "added" || !specs.some(spec => spec.path === files[0].filename))
    throw new GitHubError(422, "Merged pull request does not match its tracked specification");
  const matching = specs.filter(spec => spec.path === files[0].filename);
  const path = files[0].filename;
  const file = await github<{ content: string; encoding: string; size: number }>(installationToken.token,
    `/repos/${name}/contents/${path}?ref=${pull.merge_commit_sha}`);
  if (file.encoding !== "base64" || file.size > 45_000)
    throw new GitHubError(422, "Merged specification is unreadable or too large");
  let mergedText: string;
  try { mergedText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.content.replace(/\s/g, ""), "base64")); }
  catch { throw new GitHubError(422, "Merged specification is not valid UTF-8"); }
  const title = /^# ([^\n]+)\n/.exec(mergedText)?.[1];
  if (!title) throw new GitHubError(422, "Merged specification has no title");
  try { validateSpec(title, mergedText); }
  catch { throw new GitHubError(422, "Merged specification no longer meets the required format"); }
  for (const spec of matching) {
    if (spec.status === "merged" && spec.mergedSha !== pull.merge_commit_sha)
      throw new GitHubError(409, "Specification was already merged at a different commit");
  }
  const runs = await Promise.all(matching.filter(spec => spec.provider && spec.model).map(async spec => {
    const skills = await db.prepare("SELECT id, commit_sha AS commitSha FROM skills WHERE account_id = ? AND active = 1 AND (project_id IS NULL OR project_id = ?) ORDER BY project_id IS NULL DESC, path LIMIT 9")
      .bind(spec.accountId, spec.projectId).all<{ id: string; commitSha: string }>();
    if (skills.results.length > 8) throw new GitHubError(422, "This project has more than eight selected skills");
    const grants = await db.prepare("SELECT id FROM mcp_grants WHERE project_id = ? AND revoked_at IS NULL ORDER BY granted_at, id LIMIT 9")
      .bind(spec.projectId).all<{ id: string }>();
    if (grants.results.length > 8) throw new GitHubError(422, "This project has more than eight MCP grants");
    return { spec, id: crypto.randomUUID(), skills: skills.results, grants: grants.results };
  }));
  await db.batch([
    ...matching.map(spec => db.prepare("UPDATE specs SET status = 'merged', merged_commit_sha = ? WHERE id = ?")
      .bind(pull.merge_commit_sha, spec.id)),
    // shortcut: queued runs stay in D1 until the scheduled runner is deployed; it claims them on its next tick.
    ...runs.map(({ spec, id }) =>
      db.prepare("INSERT OR IGNORE INTO runs (id, spec_id, merged_commit_sha, model, provider, status, created_at, execution_mode) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)")
        .bind(id, spec.id, pull.merge_commit_sha, spec.model, spec.provider, Date.now(), spec.executionMode)),
    ...runs.flatMap(({ spec, id, skills }) => skills.map((skill: { id: string; commitSha: string }) =>
      db.prepare("INSERT INTO run_skills (run_id, skill_id, commit_sha) SELECT ?, ?, ? FROM runs WHERE id = ? AND spec_id = ?")
        .bind(id, skill.id, skill.commitSha, id, spec.id))),
    ...runs.flatMap(({ spec, id, grants }) => grants.map((grant: { id: string }) =>
      db.prepare("INSERT INTO run_mcp_grants (run_id, grant_id) SELECT ?, ? FROM runs WHERE id = ? AND spec_id = ?")
        .bind(id, grant.id, id, spec.id))),
    db.prepare("UPDATE webhook_deliveries SET processed_at = ? WHERE delivery_id = ?").bind(Date.now(), deliveryId),
  ]);
  return { recorded: true, status: "merged", specIds: matching.map(spec => spec.id) };
}
