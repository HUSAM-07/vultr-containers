import { NextRequest, NextResponse } from "next/server";
import { GitHubError, importContext, listRepositories, publishSpec } from "@/lib/fava-github";
import { clearSession, readSession, setSession } from "@/lib/fava-session";

function fail(error: unknown) {
  const status = error instanceof GitHubError && error.status >= 400 && error.status < 500 ? error.status : 502;
  return NextResponse.json({ error: error instanceof GitHubError ? error.message : "GitHub is unavailable" }, { status });
}

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action") || "session";
  const configured = Boolean(process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET &&
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
      : action === "context" ? await importContext(auth.session.token, repo)
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
  if (action !== "spec") return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const auth = await readSession(request);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    if (Number(request.headers.get("content-length")) > 50_000)
      return NextResponse.json({ error: "Specification is too large" }, { status: 413 });
    const text = await request.text();
    if (text.length > 50_000) return NextResponse.json({ error: "Specification is too large" }, { status: 413 });
    const { repo, title, content } = JSON.parse(text);
    if (typeof repo !== "string" || typeof title !== "string" || typeof content !== "string")
      return NextResponse.json({ error: "Invalid specification" }, { status: 400 });
    const result = await publishSpec(auth.session.token, repo, title, content);
    const response = NextResponse.json(result, { status: 201 });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return fail(error); }
}
