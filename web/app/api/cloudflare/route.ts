import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { readSession, setSession } from "@/lib/fava-session";
import { github, GitHubError } from "@/lib/fava-github";
import { readJson } from "@/lib/fava-json";
import { projectAccess } from "@/lib/fava-db";
import { cloudflare, CloudflareError, cloudflareToken, connectionFor, encryptToken, productionTrigger, recentPreviewBuilds, verifyPreviewConfig, verifyWorkerRepository, wranglerConfigPaths, type BuildTrigger, type PreviewBuild, type CloudflareConnection } from "@/lib/fava-cloudflare";

type Worker = { id: string; tag: string };
type BuildToken = { build_token_uuid: string; build_token_name: string };

function errorResponse(error: unknown) {
  const status = error instanceof CloudflareError || error instanceof GitHubError ? error.status : 502;
  return NextResponse.json({ error: error instanceof CloudflareError || error instanceof GitHubError ? error.message : "Cloudflare setup failed" },
    { status: status >= 400 && status < 600 ? status : 502 });
}

async function workersFor(connection: CloudflareConnection) {
  const token = await cloudflareToken(env.DB, connection);
  const workers = await cloudflare<Worker[]>(token,
    `/accounts/${connection.cloudflare_account_id}/workers/scripts`);
  return { token, workers };
}

async function wranglerSource(token: string, repository: string, branch: string, rootDirectory: string) {
  for (const path of wranglerConfigPaths(rootDirectory)) {
    try {
      const file = await github<{ content: string; encoding: string; size: number }>(token,
        `/repos/${repository}/contents/${path}?ref=${encodeURIComponent(branch)}`);
      if (file.encoding !== "base64" || file.size > 100_000) throw new CloudflareError(400, "Wrangler configuration is too large to verify");
      const binary = atob(file.content.replace(/\s/g, ""));
      return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
    } catch (error) { if (!(error instanceof GitHubError) || error.status !== 404) throw error; }
  }
  throw new CloudflareError(400, "Add wrangler.jsonc or wrangler.json in the Worker Builds root directory before enabling Previews");
}

export async function GET(request: NextRequest) {
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const repository = request.nextUrl.searchParams.get("repo") || "";
    const project = await projectAccess(env.DB, auth.session.user.id, repository, auth.session.token);
    const canManage = project.role === "owner" || project.role === "admin";
    const connection = await connectionFor(env.DB, project.accountId);
    const preview = await env.DB.prepare("SELECT worker_name AS workerName, worker_tag AS workerTag, trigger_uuid AS triggerUuid FROM cloudflare_project_previews WHERE project_id = ? AND account_id = ?")
      .bind(project.id, project.accountId).first<{ workerName: string; workerTag: string; triggerUuid: string }>();
    const token = connection ? await cloudflareToken(env.DB, connection) : "";
    const available = connection && canManage
      ? await cloudflare<Worker[]>(token, `/accounts/${connection.cloudflare_account_id}/workers/scripts`)
      : [];
    const buildTokens = connection && canManage
      ? await cloudflare<BuildToken[]>(token, `/accounts/${connection.cloudflare_account_id}/builds/tokens`)
      : [];
    const workers = available.map(worker => ({ name: worker.id, tag: worker.tag }));
    let builds: ReturnType<typeof recentPreviewBuilds> = [];
    if (connection && preview) {
      const list = await cloudflare<PreviewBuild[]>(token,
        `/accounts/${connection.cloudflare_account_id}/builds/workers/${preview.workerTag}/builds?per_page=30`);
      builds = recentPreviewBuilds(list, preview.triggerUuid);
      builds = await Promise.all(builds.map(async build => {
        if (build.url || build.outcome !== "success") return build;
        try {
          const detail = await cloudflare<PreviewBuild>(token,
            `/accounts/${connection.cloudflare_account_id}/builds/builds/${build.buildUuid}`);
          return { ...build, url: detail.preview_url?.startsWith("https://") ? detail.preview_url : null };
        } catch { return build; }
      }));
    }
    const response = NextResponse.json({ connected: Boolean(connection), canManage,
      oauthAvailable: Boolean(process.env.CLOUDFLARE_OAUTH_CLIENT_ID && process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET),
      authMethod: canManage ? connection?.auth_method || null : null,
      accountId: canManage ? connection?.cloudflare_account_id || null : null, workers,
      buildTokens: buildTokens.map(item => ({ id: item.build_token_uuid, name: item.build_token_name })),
      preview: canManage || !preview ? preview : { workerName: preview.workerName }, builds });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const body = await readJson(request, 2_000);
    if (!body || typeof body !== "object" || !("action" in body)) throw new CloudflareError(400, "Invalid Cloudflare request");
    const project = await projectAccess(env.DB, auth.session.user.id,
      "repo" in body && typeof body.repo === "string" ? body.repo : "", auth.session.token, "admin");
    const accountId = project.accountId;
    if (body.action === "connect") {
      if (!("cloudflareAccountId" in body) || !("token" in body) ||
        typeof body.cloudflareAccountId !== "string" || !/^[a-f0-9]{32}$/i.test(body.cloudflareAccountId) ||
        typeof body.token !== "string" || body.token.length < 20 || body.token.length > 512 || /\s/.test(body.token))
        throw new CloudflareError(400, "Enter a valid Cloudflare account ID and user API token");
      await cloudflare<Worker[]>(body.token, `/accounts/${body.cloudflareAccountId}/workers/scripts`);
      await cloudflare(body.token, `/accounts/${body.cloudflareAccountId}/builds/tokens`);
      const current = await connectionFor(env.DB, accountId);
      const save = env.DB.prepare("INSERT INTO cloudflare_connections (account_id, cloudflare_account_id, token_ciphertext, connected_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET cloudflare_account_id = excluded.cloudflare_account_id, token_ciphertext = excluded.token_ciphertext, auth_method = 'token', refresh_ciphertext = NULL, token_expires_at = NULL, connected_at = excluded.connected_at")
        .bind(accountId, body.cloudflareAccountId, await encryptToken(body.token), Date.now());
      if (current && current.cloudflare_account_id !== body.cloudflareAccountId)
        await env.DB.batch([env.DB.prepare("DELETE FROM cloudflare_project_previews WHERE account_id = ?").bind(accountId), save]);
      else await save.run();
      const response = NextResponse.json({ connected: true });
      if (auth.refreshed) await setSession(response, request, auth.session);
      return response;
    }
    if (body.action !== "enable" || !("repo" in body) || typeof body.repo !== "string" ||
      !("workerName" in body) || typeof body.workerName !== "string")
      throw new CloudflareError(400, "Choose a Worker to enable Previews");
    const connection = await connectionFor(env.DB, accountId);
    if (!connection) throw new CloudflareError(400, "Connect Cloudflare first");
    const { token, workers } = await workersFor(connection);
    const worker = workers.find(item => item.id === body.workerName);
    if (!worker?.tag) throw new CloudflareError(400, "Select a Worker in the connected Cloudflare account");
    const triggers = await cloudflare<BuildTrigger[]>(token,
      `/accounts/${connection.cloudflare_account_id}/builds/workers/${worker.tag}/triggers`);
    const [owner, name] = body.repo.split("/");
    const repository = await github<{ id: number; owner: { id: number; login: string } }>(auth.session.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    if (repository.id !== project.githubRepoId) throw new CloudflareError(403, "Repository identity changed; relink it to Fava");
    const existingProduction = productionTrigger(triggers, project.defaultBranch, repository.id);
    const rootDirectory = existingProduction?.root_directory ||
      ("rootDirectory" in body && typeof body.rootDirectory === "string" ? body.rootDirectory : "/");
    const source = await wranglerSource(auth.session.token, body.repo, project.defaultBranch, rootDirectory);
    verifyPreviewConfig(source, worker.id);
    const knownConnection = triggers.find(item => item.repo_connection?.provider_type === "github" &&
      item.repo_connection.repo_id === String(repository.id) && item.repo_connection_uuid)?.repo_connection_uuid;
    const repoConnectionUuid = knownConnection || (await cloudflare<{ repo_connection_uuid: string }>(token,
      `/accounts/${connection.cloudflare_account_id}/builds/repos/connections`, "PUT", {
        provider_type: "github", provider_account_id: String(repository.owner.id),
        provider_account_name: repository.owner.login, repo_id: String(repository.id), repo_name: name })).repo_connection_uuid;
    if (!repoConnectionUuid) throw new CloudflareError(502, "Cloudflare did not return a repository connection ID");
    verifyWorkerRepository(triggers, repoConnectionUuid, repository.id);
    let production = productionTrigger(triggers, project.defaultBranch, repository.id) ||
      productionTrigger(triggers, project.defaultBranch, repository.id, repoConnectionUuid);
    if (!production) {
      const buildTokenId = "buildTokenId" in body && typeof body.buildTokenId === "string" ? body.buildTokenId : "";
      const buildCommand = "buildCommand" in body && typeof body.buildCommand === "string" ? body.buildCommand : "";
      if (buildCommand.length > 200 || /[\r\n\0]/.test(buildCommand))
        throw new CloudflareError(400, "Enter a valid build command");
      const buildTokens = await cloudflare<BuildToken[]>(token,
        `/accounts/${connection.cloudflare_account_id}/builds/tokens`);
      if (!buildTokens.some(item => item.build_token_uuid === buildTokenId))
        throw new CloudflareError(400, "Select an existing Cloudflare Builds deployment token");
      production = await cloudflare<BuildTrigger>(token,
        `/accounts/${connection.cloudflare_account_id}/builds/triggers`, "POST", {
          external_script_id: worker.tag, repo_connection_uuid: repoConnectionUuid,
          build_token_uuid: buildTokenId, trigger_name: "Fava production",
          build_command: buildCommand, deploy_command: "npx wrangler deploy", root_directory: rootDirectory,
          branch_includes: [project.defaultBranch], branch_excludes: [],
          path_includes: ["*"], path_excludes: [],
        });
    }
    if (!production.repo_connection_uuid || !production.build_token_uuid)
      throw new CloudflareError(502, "Cloudflare did not return a complete production trigger; retry this setup");
    const existing = triggers.find(item => item.branch_includes?.includes("*") &&
      item.branch_excludes?.includes(project.defaultBranch) &&
      item.repo_connection_uuid === production.repo_connection_uuid);
    let triggerUuid = existing?.trigger_uuid;
    if (existing && existing.deploy_command !== "npx wrangler preview")
      throw new CloudflareError(400, "Switch this Worker's existing Preview build to Worker Previews in Cloudflare first; that migration cannot be reversed");
    if (!existing) {
      const trigger = await cloudflare<{ trigger_uuid: string }>(token,
        `/accounts/${connection.cloudflare_account_id}/builds/triggers`, "POST", {
          external_script_id: worker.tag, repo_connection_uuid: production.repo_connection_uuid,
          build_token_uuid: production.build_token_uuid, trigger_name: "Fava branch previews",
          build_command: production.build_command ?? "",
          deploy_command: "npx wrangler preview", root_directory: production.root_directory || "/",
          branch_includes: ["*"], branch_excludes: [project.defaultBranch],
          path_includes: production.path_includes || ["*"], path_excludes: production.path_excludes || [],
        });
      triggerUuid = trigger.trigger_uuid;
    }
    if (!triggerUuid) throw new CloudflareError(502, "Cloudflare did not return a Preview trigger ID");
    try {
      await env.DB.prepare("INSERT INTO cloudflare_project_previews (project_id, account_id, worker_name, worker_tag, trigger_uuid, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET account_id = excluded.account_id, worker_name = excluded.worker_name, worker_tag = excluded.worker_tag, trigger_uuid = excluded.trigger_uuid, created_at = excluded.created_at")
        .bind(project.id, accountId, worker.id, worker.tag, triggerUuid, Date.now()).run();
    } catch { throw new CloudflareError(502, `Preview trigger ${triggerUuid} was created, but Fava could not save it. Reopen this project to retry.`); }
    const response = NextResponse.json({ workerName: worker.id, triggerUuid });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const project = await projectAccess(env.DB, auth.session.user.id,
      request.nextUrl.searchParams.get("repo") || "", auth.session.token, "admin");
    await env.DB.prepare("DELETE FROM cloudflare_connections WHERE account_id = ?")
      .bind(project.accountId).run();
    const response = NextResponse.json({ connected: false });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return errorResponse(error); }
}
