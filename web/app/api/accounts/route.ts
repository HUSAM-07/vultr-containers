import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { readSession, setSession } from "@/lib/fava-session";
import { GitHubError } from "@/lib/fava-github";
import { accountAccess, createAccount, listAccountMembers, listAccounts,
  removeAccountMember, setAccountMember } from "@/lib/fava-db";
import { readJson } from "@/lib/fava-json";

function fail(error: unknown) {
  return NextResponse.json({ error: error instanceof GitHubError ? error.message : "Workspaces are unavailable" },
    { status: error instanceof GitHubError ? error.status : 502 });
}

export async function GET(request: NextRequest) {
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const accountId = request.nextUrl.searchParams.get("accountId");
    const value = accountId
      ? await listAccountMembers(env.DB, (await accountAccess(env.DB, auth.session.user.id, accountId, "admin")).id)
      : await listAccounts(env.DB, auth.session.user.id);
    const response = NextResponse.json(value);
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
    if (!body || typeof body !== "object" || !("action" in body)) throw new GitHubError(400, "Invalid workspace request");
    if (body.action === "create") {
      if (!("name" in body) || typeof body.name !== "string" ||
        body.name.trim().length < 2 || body.name.trim().length > 80)
        throw new GitHubError(400, "Use a workspace name of 2–80 characters");
      const account = await createAccount(env.DB, auth.session.user.id, body.name.trim());
      const response = NextResponse.json(account, { status: 201 });
      if (auth.refreshed) await setSession(response, request, auth.session);
      return response;
    }
    if (!("accountId" in body) || typeof body.accountId !== "string" || body.accountId.length > 100)
      throw new GitHubError(400, "Choose a workspace");
    const account = await accountAccess(env.DB, auth.session.user.id, body.accountId, "admin");
    if (body.action === "member") {
      if (!("login" in body) || typeof body.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(body.login) ||
        !("role" in body) || !["admin", "editor", "viewer"].includes(String(body.role)))
        throw new GitHubError(400, "Choose a GitHub user and workspace role");
      await setAccountMember(env.DB, account.id, auth.session.token, body.login,
        body.role as "admin" | "editor" | "viewer");
    } else if (body.action === "remove") {
      if (!("githubId" in body) || !Number.isSafeInteger(body.githubId) || Number(body.githubId) <= 0)
        throw new GitHubError(400, "Choose a workspace member");
      await removeAccountMember(env.DB, account.id, Number(body.githubId));
    } else throw new GitHubError(400, "Invalid workspace action");
    const response = NextResponse.json(await listAccountMembers(env.DB, account.id));
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return fail(error); }
}
