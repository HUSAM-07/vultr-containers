import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { readSession, setSession } from "@/lib/fava-session";
import { projectAccess } from "@/lib/fava-db";
import { GitHubError } from "@/lib/fava-github";
import { CloudflareError, encryptToken } from "@/lib/fava-cloudflare";
import { readJson } from "@/lib/fava-json";
import { mcpServerUrl, mcpTools } from "@/lib/fava-mcp";

function fail(error: unknown) {
  const status = error instanceof GitHubError || error instanceof CloudflareError ? error.status : 502;
  return NextResponse.json({ error: error instanceof GitHubError || error instanceof CloudflareError ? error.message : "MCP grants are unavailable" },
    { status });
}

async function list(projectId: string) {
  const result = await env.DB.prepare("SELECT id, server_url AS serverUrl, allowed_tools_json AS allowedToolsJson, granted_at AS grantedAt FROM mcp_grants WHERE project_id = ? AND revoked_at IS NULL ORDER BY granted_at, id")
    .bind(projectId).all<{ id: string; serverUrl: string; allowedToolsJson: string; grantedAt: number }>();
  return result.results.map(({ allowedToolsJson, ...grant }: { id: string; serverUrl: string; allowedToolsJson: string; grantedAt: number }) => ({ ...grant,
    allowedTools: JSON.parse(allowedToolsJson) as string[] }));
}

export async function GET(request: NextRequest) {
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const project = await projectAccess(env.DB, auth.session.user.id,
      request.nextUrl.searchParams.get("repo") || "", auth.session.token);
    const response = NextResponse.json({ grants: await list(project.id),
      canManage: project.role === "owner" || project.role === "admin" });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return fail(error); }
}

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const body = await readJson(request, 3_000);
    if (!body || typeof body !== "object" || !("repo" in body) || typeof body.repo !== "string" ||
      !("action" in body) || typeof body.action !== "string") throw new GitHubError(400, "Invalid MCP grant request");
    const project = await projectAccess(env.DB, auth.session.user.id, body.repo, auth.session.token, "admin");
    if (body.action === "add") {
      let serverUrl: string;
      let tools: string[];
      try {
        serverUrl = mcpServerUrl("serverUrl" in body && typeof body.serverUrl === "string" ? body.serverUrl : "");
        tools = mcpTools("allowedTools" in body ? body.allowedTools : null);
      } catch (error) { throw new GitHubError(400, (error as Error).message); }
      const bearerToken = "bearerToken" in body ? body.bearerToken : null;
      if (bearerToken !== null && (typeof bearerToken !== "string" || bearerToken.length < 1 ||
        bearerToken.length > 2_000 || /\s/.test(bearerToken)))
        throw new GitHubError(400, "Enter a valid MCP bearer token");
      const active = await list(project.id);
      if (active.length >= 8) throw new GitHubError(400, "Each project can connect at most eight MCP servers");
      if (active.some((grant: { serverUrl: string }) => grant.serverUrl === serverUrl))
        throw new GitHubError(409, "This MCP server is already connected to the project");
      await env.DB.prepare("INSERT INTO mcp_grants (id, project_id, server_url, allowed_tools_json, credential_ref, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), project.id, serverUrl, JSON.stringify(tools),
          bearerToken ? await encryptToken(bearerToken, "mcp") : null,
          auth.session.user.id, Date.now()).run();
    } else if (body.action === "revoke") {
      if (!("id" in body) || typeof body.id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.id))
        throw new GitHubError(400, "Choose an MCP grant");
      await env.DB.prepare("UPDATE mcp_grants SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL")
        .bind(Date.now(), body.id, project.id).run();
    } else throw new GitHubError(400, "Invalid MCP grant action");
    const response = NextResponse.json({ grants: await list(project.id) });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return fail(error); }
}
