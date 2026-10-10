import { WorkerEntrypoint } from "cloudflare:workers";
import { forwardMcp, type McpGrant } from "../../web/lib/fava-mcp.ts";
import { gatewayRequest, readRunCapability } from "./capability";
import { appJwt, installationToken, isGitReadRequest } from "./github";
import type { Env } from "./types";

type AllowedRun = { repository: string; repositoryId: number; installationId: number };
export class Outbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return new Response("HTTPS required", { status: 403 });
    if (url.hostname === "ai.fava.invalid") return this.gateway(request, url);
    if (url.hostname === "mcp.fava.invalid") return this.mcp(request, url);
    const runId = readRunCapability(request.headers.get("x-fava-run-capability"), this.env.FAVA_RUN_SECRET);
    if (!runId) return new Response("Forbidden", { status: 403 });
    const run = await this.env.DB.prepare("SELECT projects.full_name AS repository, projects.github_repo_id AS repositoryId, projects.installation_id AS installationId FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE runs.id = ? AND runs.status = 'running' AND projects.installation_id > 0 AND specs.status = 'merged' AND runs.merged_commit_sha = specs.merged_commit_sha")
      .bind(runId).first<AllowedRun>();
    if (!run || !isGitReadRequest(url, request.method, run.repository))
      return new Response("Forbidden", { status: 403 });
    const token = await installationToken(appJwt(this.env.GITHUB_APP_CLIENT_ID, this.env.GITHUB_APP_PRIVATE_KEY),
      run.installationId, run.repositoryId);
    const headers = new Headers(request.headers);
    headers.delete("x-fava-run-capability");
    headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
    return fetch(new Request(request, { headers }));
  }

  private async gateway(request: Request, url: URL): Promise<Response> {
    const route = gatewayRequest(url, this.env.FAVA_RUN_SECRET);
    if (!route || !["GET", "POST"].includes(request.method))
      return new Response("Forbidden", { status: 403 });
    const run = await this.env.DB.prepare("SELECT 1 FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE runs.id = ? AND runs.status = 'running' AND specs.status = 'merged' AND runs.merged_commit_sha = specs.merged_commit_sha AND projects.installation_id > 0")
      .bind(route.runId).first();
    if (!run) return new Response("Forbidden", { status: 403 });
    const target = `https://gateway.ai.cloudflare.com/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}${route.path}`;
    const proxied = new Request(target, request);
    proxied.headers.delete("authorization");
    proxied.headers.delete("x-api-key");
    proxied.headers.set("cf-aig-authorization", `Bearer ${this.env.AI_GATEWAY_TOKEN}`);
    return fetch(proxied, { redirect: "manual", cache: "no-store" });
  }

  private async mcp(request: Request, url: URL): Promise<Response> {
    if (url.port || url.search || url.hash || !/^\/[a-f0-9-]{36}$/i.test(url.pathname) ||
      !["GET", "POST", "DELETE"].includes(request.method))
      return new Response("Forbidden", { status: 403 });
    const capability = request.headers.get("authorization")?.replace(/^Bearer /i, "");
    const runId = readRunCapability(capability || null, this.env.FAVA_RUN_SECRET);
    if (!runId) return new Response("Forbidden", { status: 403 });
    const grant = await this.env.DB.prepare("SELECT mcp_grants.server_url AS serverUrl, mcp_grants.allowed_tools_json AS toolsJson, mcp_grants.credential_ref AS credentialRef FROM run_mcp_grants JOIN mcp_grants ON mcp_grants.id = run_mcp_grants.grant_id JOIN runs ON runs.id = run_mcp_grants.run_id JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE run_mcp_grants.run_id = ? AND run_mcp_grants.grant_id = ? AND runs.status = 'running' AND projects.installation_id > 0 AND specs.status = 'merged' AND runs.merged_commit_sha = specs.merged_commit_sha AND mcp_grants.project_id = specs.project_id AND mcp_grants.revoked_at IS NULL")
      .bind(runId, url.pathname.slice(1)).first<McpGrant>();
    if (!grant) return new Response("Forbidden", { status: 403 });
    return forwardMcp(request, grant, this.env.FAVA_SESSION_SECRET);
  }
}
