import { WorkerEntrypoint } from "cloudflare:workers";
import { readRunCapability } from "./capability";
import { appJwt, installationToken, isGitReadRequest } from "./github";
import type { Env } from "./types";

type AllowedRun = { repository: string; repositoryId: number; installationId: number };

export class Outbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return new Response("HTTPS required", { status: 403 });
    const gatewayPath = `/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}`;
    if (url.hostname === "gateway.ai.cloudflare.com" &&
      (url.pathname === gatewayPath || url.pathname.startsWith(`${gatewayPath}/`))) {
      const headers = new Headers(request.headers);
      headers.delete("x-api-key");
      headers.set("cf-aig-authorization", `Bearer ${this.env.AI_GATEWAY_TOKEN}`);
      return fetch(new Request(request, { headers }));
    }
    const runId = readRunCapability(request.headers.get("x-fava-run-capability"), this.env.FAVA_RUN_SECRET);
    if (!runId) return new Response("Forbidden", { status: 403 });
    const run = await this.env.DB.prepare("SELECT projects.full_name AS repository, projects.github_repo_id AS repositoryId, projects.installation_id AS installationId FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE runs.id = ? AND runs.status = 'running' AND specs.status = 'merged' AND runs.merged_commit_sha = specs.merged_commit_sha")
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
}
