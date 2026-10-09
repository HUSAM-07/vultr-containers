import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { ensurePersonalAccount, linkProject, listProjects, listRuns, recordSpec } from "@/lib/fava-db";
import { GitHubError, importContext, listRepositories, listSpecPullRequests, parseRepo, publishSpec } from "@/lib/fava-github";
import { readJson } from "@/lib/fava-json";
import { chooseModel } from "@/lib/fava-models";
import { clearSession, readSession, setSession } from "@/lib/fava-session";

function fail(error: unknown) {
  const status = error instanceof GitHubError && error.status >= 400 && error.status < 500 ? error.status : 502;
  return NextResponse.json({ error: error instanceof GitHubError ? error.message : "GitHub is unavailable" }, { status });
}

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action") || "session";
  const configured = Boolean(env.DB && process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET &&
    process.env.FAVA_SESSION_SECRET && process.env.FAVA_SESSION_SECRET.length >= 32);
  if (action === "session" && !configured) return NextResponse.json({ configured: false, connected: false });
  try {
    const auth = await readSession(request);
    if (action === "session") {
      const response = NextResponse.json({ configured, connected: Boolean(auth), user: auth?.session.user || null,
        installUrl: process.env.GITHUB_APP_SLUG ? `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new` : null });
      if (auth?.refreshed) await setSession(response, request, auth.session);
      return response;
    }
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const repo = request.nextUrl.searchParams.get("repo") || "";
    const value = action === "repos" ? await listRepositories(auth.session.token)
      : action === "projects" ? await listProjects(env.DB, `github:${auth.session.user.id}`)
      : action === "runs" ? await listRuns(env.DB, `github:${auth.session.user.id}`, parseRepo(repo))
      : action === "context" ? await importContext(auth.session.token, repo)
      : action === "specs" ? await listSpecPullRequests(auth.session.token, repo)
      : null;
    if (!value) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const response = NextResponse.json(value);
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return fail(error); }
}

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const action = request.nextUrl.searchParams.get("action");
  if (action === "logout") {
    const response = NextResponse.json({ ok: true });
    clearSession(response);
    return response;
  }
  if (action !== "spec" && action !== "project") return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const auth = await readSession(request);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    if (action === "project") {
      const body = await readJson(request, 1_000);
      if (!body || typeof body !== "object" || !("repo" in body) || typeof body.repo !== "string")
        throw new GitHubError(400, "Choose a valid repository");
      const name = parseRepo(body.repo);
      const available = await listRepositories(auth.session.token);
      const selected = available.find(item => item.fullName.toLowerCase() === name.toLowerCase());
      if (!selected) throw new GitHubError(403, "Install the Fava GitHub App on this repository first");
      const accountId = await ensurePersonalAccount(env.DB, auth.session.user);
      const project = await linkProject(env.DB, accountId, selected);
      const response = NextResponse.json(project, { status: 201 });
      if (auth.refreshed) await setSession(response, request, auth.session);
      return response;
    }
    const body = await readJson(request, 50_000);
    if (!body || typeof body !== "object" || !("repo" in body) || !("title" in body) || !("content" in body) || !("model" in body))
      throw new GitHubError(400, "Invalid specification");
    const { repo, title, content, model } = body;
    if (typeof repo !== "string" || typeof title !== "string" || typeof content !== "string")
      return NextResponse.json({ error: "Invalid specification" }, { status: 400 });
    let selected: ReturnType<typeof chooseModel>;
    try { selected = chooseModel(model); }
    catch { throw new GitHubError(400, "Choose a supported agent model"); }
    const linked = await env.DB.prepare("SELECT id FROM projects WHERE account_id = ? AND full_name = ?")
      .bind(`github:${auth.session.user.id}`, parseRepo(repo)).first<{ id: string }>();
    if (!linked) throw new GitHubError(403, "Link this repository to your Fava account first");
    const result = await publishSpec(auth.session.token, repo, title, content);
    try { await recordSpec(env.DB, linked.id, auth.session.user.id, result, selected); }
    catch { throw new GitHubError(502, `Spec PR ${result.url} was created, but Fava could not track it. Contact the project owner before merging.`); }
    const response = NextResponse.json(result, { status: 201 });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return fail(error); }
}
