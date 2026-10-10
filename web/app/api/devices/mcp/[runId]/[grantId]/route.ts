import { NextRequest } from "next/server";
import { env } from "@/lib/runtime-env";
import { GitHubError } from "@/lib/fava-github";
import { forwardMcp } from "@/lib/fava-mcp";
import { authorizedLocalMcpGrant } from "@/lib/fava-local-mcp";

type Context = { params: Promise<{ runId: string; grantId: string }> };

async function proxy(request: NextRequest, context: Context) {
  if (request.nextUrl.search || request.nextUrl.hash)
    return new Response("Forbidden", { status: 403 });
  try {
    const { runId, grantId } = await context.params;
    const secret = process.env.FAVA_SESSION_SECRET || "";
    const grant = await authorizedLocalMcpGrant(env.DB, runId, grantId,
      request.headers.get("authorization"), secret);
    return forwardMcp(request, grant, secret);
  } catch (error) {
    return new Response(error instanceof GitHubError ? error.message : "Local MCP is unavailable",
      { status: error instanceof GitHubError ? error.status : 502, headers: { "Cache-Control": "no-store" } });
  }
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
