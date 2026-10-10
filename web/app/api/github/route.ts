import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { accountAccess, cancelRun, ensurePersonalAccount, linkProject, listProjects, listRuns, projectAccess, recordSpec } from "@/lib/fava-db";
import { addCreatedRepositoryToInstallation, createRepository, GitHubError, importContext, listRepositories, listSpecPullRequests, parseRepo, publishSpec, readContextFile } from "@/lib/fava-github";
import { readJson } from "@/lib/fava-json";
import { requireLocalRunReady } from "@/lib/fava-devices";
import { chooseModel } from "@/lib/fava-models";
import { refreshRunPreviews } from "@/lib/fava-run-previews";
import { clearSession, readSession, revokeSession, setSession } from "@/lib/fava-session";
import { requireWebhookReady } from "@/lib/fava-webhook";

function fail(error: unknown) {
  const status = error instanceof GitHubError && error.status >= 400 && error.status < 500 ? error.status : 502;
  return NextResponse.json({ error: error instanceof GitHubError ? error.message : "GitHub is unavailable" }, { status });
}

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action") || "session";
  const configured = Boolean(env.DB && process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET &&
    process.env.GITHUB_APP_PRIVATE_KEY &&
    process.env.FAVA_SESSION_SECRET && process.env.FAVA_SESSION_SECRET.length >= 32);
  if (action === "session" && !configured) return NextResponse.json({ configured: false, connected: false });
  try {
    const auth = await readSession(request, env.DB);
    if (action === "session") {
      const response = NextResponse.json({ configured, connected: Boolean(auth), user: auth?.session.user || null,
        installUrl: process.env.GITHUB_APP_SLUG ? `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new` : null });
      if (auth?.refreshed) await setSession(response, request, auth.session);
      return response;
    }
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const repo = request.nextUrl.searchParams.get("repo") || "";
    let value: unknown = null;
    if (action === "repos") value = await listRepositories(auth.session.token);
    else if (action === "projects") value = await listProjects(env.DB, auth.session.user.id,
      await listRepositories(auth.session.token));
    else if (["runs", "context", "specs", "file"].includes(action)) {
      const project = await projectAccess(env.DB, auth.session.user.id, repo, auth.session.token);
      if (action === "runs") {
        const runs = await listRuns(env.DB, project.accountId, project.repository);
        try { await refreshRunPreviews(env.DB, project.accountId, project.id, runs,
          request.nextUrl.searchParams.get("refresh") === "1"); }
        catch (error) { console.error("Run Preview refresh failed", project.id, error instanceof Error ? error.name : "unknown"); }
        value = runs;
      } else if (action === "file") value = await readContextFile(auth.session.token, project.repository,
        request.nextUrl.searchParams.get("path") || "", request.nextUrl.searchParams.get("ref") || "");
      else value = action === "context" ? await importContext(auth.session.token, project.repository)
        : await listSpecPullRequests(auth.session.token, project.repository);
    }
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
    try { if (env.DB) await revokeSession(env.DB, request); }
    catch { return NextResponse.json({ error: "Could not revoke this session" }, { status: 503 }); }
    const response = NextResponse.json({ ok: true });
    clearSession(response);
    return response;
  }
  if (action !== "spec" && action !== "project" && action !== "createRepository" && action !== "cancelRun")
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    if (action === "cancelRun") {
      const body = await readJson(request, 1_000);
      if (!body || typeof body !== "object" || !("repo" in body) || typeof body.repo !== "string" ||
        !("runId" in body) || typeof body.runId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.runId))
        throw new GitHubError(400, "Choose a valid run");
      const project = await projectAccess(env.DB, auth.session.user.id, body.repo, auth.session.token, "editor");
      const reason = await cancelRun(env.DB, project.id, body.runId);
      const response = NextResponse.json({ status: "cancelled", error: reason });
      if (auth.refreshed) await setSession(response, request, auth.session);
      return response;
    }
    if (action === "project") {
      const body = await readJson(request, 1_000);
      if (!body || typeof body !== "object" || !("repo" in body) || typeof body.repo !== "string")
        throw new GitHubError(400, "Choose a valid repository");
      const name = parseRepo(body.repo);
      const available = await listRepositories(auth.session.token);
      const selected = available.find(item => item.fullName.toLowerCase() === name.toLowerCase());
      if (!selected) throw new GitHubError(403, "Install the Fava GitHub App on this repository first");
      const accountId = "accountId" in body && typeof body.accountId === "string"
        ? body.accountId : await ensurePersonalAccount(env.DB, auth.session.user);
      const account = await accountAccess(env.DB, auth.session.user.id, accountId, "admin");
      const project = await linkProject(env.DB, accountId, selected);
      const response = NextResponse.json({ ...project, accountId, accountName: account.name,
        role: account.role, accountRole: account.role }, { status: 201 });
      if (auth.refreshed) await setSession(response, request, auth.session);
      return response;
    }
    if (action === "createRepository") {
      const body = await readJson(request, 1_000);
      if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string" ||
        !("private" in body) || typeof body.private !== "boolean")
        throw new GitHubError(400, "Choose a repository name and visibility");
      const accountId = "accountId" in body && typeof body.accountId === "string" && body.accountId
        ? body.accountId : await ensurePersonalAccount(env.DB, auth.session.user);
      const account = await accountAccess(env.DB, auth.session.user.id, accountId, "admin");
      const created = await createRepository(auth.session.token, auth.session.user.login, body.name, body.private);
      let project = null;
      let connectionError = null;
      try {
        await addCreatedRepositoryToInstallation(auth.session.token, auth.session.user.login, created.id);
        const selected = (await listRepositories(auth.session.token)).find(item => item.id === created.id);
        if (selected) project = { ...await linkProject(env.DB, accountId, selected), accountId,
          accountName: account.name, role: account.role, accountRole: account.role };
      } catch (error) {
        console.error("New repository was created but could not be linked", created.fullName,
          error instanceof Error ? error.name : "unknown");
        connectionError = error instanceof GitHubError ? error.message : "Fava could not check the App connection. Try again shortly.";
      }
      const response = NextResponse.json({ repository: created, project, connectionError }, { status: 201 });
      if (auth.refreshed) await setSession(response, request, auth.session);
      return response;
    }
    const body = await readJson(request, 50_000);
    if (!body || typeof body !== "object" || !("repo" in body) || !("title" in body) || !("content" in body) || !("model" in body))
      throw new GitHubError(400, "Invalid specification");
    const { repo, title, content, model } = body;
    const executionMode = "executionMode" in body ? body.executionMode : "cloud";
    if (typeof repo !== "string" || typeof title !== "string" || typeof content !== "string")
      return NextResponse.json({ error: "Invalid specification" }, { status: 400 });
    if (executionMode !== "cloud" && executionMode !== "local")
      throw new GitHubError(400, "Choose cloud or local execution");
    let selected: ReturnType<typeof chooseModel>;
    try { selected = chooseModel(model); }
    catch { throw new GitHubError(400, "Choose a supported agent model"); }
    const linked = await projectAccess(env.DB, auth.session.user.id, repo, auth.session.token, "editor");
    if (executionMode === "local") await requireLocalRunReady(env.DB, linked.id);
    await requireWebhookReady(process.env.GITHUB_APP_CLIENT_ID, process.env.GITHUB_APP_PRIVATE_KEY);
    const result = await publishSpec(auth.session.token, repo, title, content);
    try { await recordSpec(env.DB, linked.id, auth.session.user.id, result, selected, executionMode); }
    catch { throw new GitHubError(502, `Spec PR ${result.url} was created, but Fava could not track it. Contact the project owner before merging.`); }
    const response = NextResponse.json(result, { status: 201 });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return fail(error); }
}
