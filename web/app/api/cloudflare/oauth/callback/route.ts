import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { readSession, setSession } from "@/lib/fava-session";
import { projectAccess } from "@/lib/fava-db";
import { cloudflare, connectionFor, decryptToken, encryptToken } from "@/lib/fava-cloudflare";

type Context = { state: string; verifier: string; sessionId: string; accountId: string;
  cloudflareAccountId: string; repo: string; issuedAt: number };
type Token = { access_token?: string; refresh_token?: string; expires_in?: number };

export async function GET(request: NextRequest) {
  const clientId = process.env.CLOUDFLARE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    return NextResponse.json({ error: "Cloudflare OAuth is not configured" }, { status: 503 });
  const auth = await readSession(request, env.DB);
  if (!auth) return NextResponse.json({ error: "Sign in to Fava and try again" }, { status: 401 });
  try {
    const raw = request.cookies.get("fava_cf_oauth")?.value;
    if (!raw) throw Error("Missing OAuth state");
    const context = JSON.parse(await decryptToken(raw)) as Context;
    if (!context.state || context.state !== request.nextUrl.searchParams.get("state") ||
      !context.verifier || context.sessionId !== auth.session.id ||
      !Number.isFinite(context.issuedAt) || Date.now() - context.issuedAt > 600_000 ||
      !/^[a-f0-9]{32}$/i.test(context.cloudflareAccountId)) throw Error("Invalid OAuth state");
    const code = request.nextUrl.searchParams.get("code");
    if (!code) throw Error("Missing authorization code");
    const project = await projectAccess(env.DB, auth.session.user.id, context.repo, auth.session.token, "admin");
    if (project.accountId !== context.accountId) throw Error("Workspace changed");
    const tokenResponse = await fetch("https://dash.cloudflare.com/oauth2/token", {
      method: "POST", headers: { Authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`,
        "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: context.verifier,
        redirect_uri: new URL("/api/cloudflare/oauth/callback", request.nextUrl.origin).toString() }),
      cache: "no-store",
    });
    const token = await tokenResponse.json().catch(() => null) as Token | null;
    if (!tokenResponse.ok || !token?.access_token || !token.refresh_token ||
      !Number.isFinite(token.expires_in) || token.expires_in! <= 0) throw Error("Invalid OAuth token");
    await cloudflare(token.access_token,
      `/accounts/${context.cloudflareAccountId}/workers/scripts`);
    await cloudflare(token.access_token,
      `/accounts/${context.cloudflareAccountId}/builds/tokens`);
    const current = await connectionFor(env.DB, context.accountId);
    const save = env.DB.prepare("INSERT INTO cloudflare_connections (account_id, cloudflare_account_id, token_ciphertext, connected_at, auth_method, refresh_ciphertext, token_expires_at) VALUES (?, ?, ?, ?, 'oauth', ?, ?) ON CONFLICT(account_id) DO UPDATE SET cloudflare_account_id = excluded.cloudflare_account_id, token_ciphertext = excluded.token_ciphertext, connected_at = excluded.connected_at, auth_method = 'oauth', refresh_ciphertext = excluded.refresh_ciphertext, token_expires_at = excluded.token_expires_at")
      .bind(context.accountId, context.cloudflareAccountId, await encryptToken(token.access_token),
        Date.now(), await encryptToken(token.refresh_token), Date.now() + token.expires_in! * 1000);
    if (current && current.cloudflare_account_id !== context.cloudflareAccountId)
      await env.DB.batch([env.DB.prepare("DELETE FROM cloudflare_project_previews WHERE account_id = ?").bind(context.accountId), save]);
    else await save.run();
    const response = NextResponse.redirect(new URL("/app", request.nextUrl.origin));
    response.cookies.set("fava_cf_oauth", "", { httpOnly: true, sameSite: "lax",
      path: "/api/cloudflare/oauth", maxAge: 0 });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch {
    const response = NextResponse.json({ error: "Cloudflare authorization failed. Check the selected account and try again." }, { status: 400 });
    response.cookies.set("fava_cf_oauth", "", { httpOnly: true, sameSite: "lax",
      path: "/api/cloudflare/oauth", maxAge: 0 });
    return response;
  }
}
