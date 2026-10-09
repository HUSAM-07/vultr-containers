import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { readSession, setSession } from "@/lib/fava-session";
import { GitHubError } from "@/lib/fava-github";
import { listProjectMembers, projectAccess, removeProjectMember, setProjectMember } from "@/lib/fava-db";
import { readJson } from "@/lib/fava-json";

function fail(error: unknown) {
  return NextResponse.json({ error: error instanceof GitHubError ? error.message : "Project members are unavailable" },
    { status: error instanceof GitHubError ? error.status : 502 });
}

export async function GET(request: NextRequest) {
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const project = await projectAccess(env.DB, auth.session.user.id,
      request.nextUrl.searchParams.get("repo") || "", auth.session.token, "admin");
    const response = NextResponse.json(await listProjectMembers(env.DB, project.id));
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
    const body = await readJson(request, 1_000);
    if (!body || typeof body !== "object" || !("repo" in body) || typeof body.repo !== "string" ||
      !("action" in body) || typeof body.action !== "string") throw new GitHubError(400, "Invalid member request");
    const project = await projectAccess(env.DB, auth.session.user.id, body.repo, auth.session.token, "admin");
    if (body.action === "add") {
      if (!("login" in body) || typeof body.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(body.login) ||
        !("role" in body) || !["admin", "editor", "viewer"].includes(String(body.role)))
        throw new GitHubError(400, "Choose a GitHub user and project role");
      await setProjectMember(env.DB, project.id, auth.session.token, body.login,
        body.role as "admin" | "editor" | "viewer");
    } else if (body.action === "remove") {
      if (!("githubId" in body) || !Number.isSafeInteger(body.githubId) || Number(body.githubId) <= 0)
        throw new GitHubError(400, "Choose a project member");
      await removeProjectMember(env.DB, project.id, Number(body.githubId));
    } else throw new GitHubError(400, "Invalid member action");
    const response = NextResponse.json(await listProjectMembers(env.DB, project.id));
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return fail(error); }
}
