import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { readSession, setSession } from "@/lib/fava-session";
import { projectAccess } from "@/lib/fava-db";
import { encryptToken } from "@/lib/fava-cloudflare";

export async function GET(request: NextRequest) {
  const clientId = process.env.CLOUDFLARE_OAUTH_CLIENT_ID;
  if (!clientId || !process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET)
    return NextResponse.json({ error: "Cloudflare OAuth is not configured" }, { status: 503 });
  const auth = await readSession(request, env.DB);
  if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
  const repo = request.nextUrl.searchParams.get("repo") || "";
  const cloudflareAccountId = request.nextUrl.searchParams.get("account") || "";
  if (!/^[a-f0-9]{32}$/i.test(cloudflareAccountId))
    return NextResponse.json({ error: "Enter a valid Cloudflare account ID" }, { status: 400 });
  try {
    const project = await projectAccess(env.DB, auth.session.user.id, repo, auth.session.token, "admin");
    const state = crypto.randomUUID();
    const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const callback = new URL("/api/cloudflare/oauth/callback", request.nextUrl.origin).toString();
    const target = new URL("https://dash.cloudflare.com/oauth2/auth");
    for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId,
      redirect_uri: callback, scope: "workers-scripts.content_read workers-ci.write offline_access",
      state, code_challenge: challenge, code_challenge_method: "S256" })) target.searchParams.set(key, value);
    const response = NextResponse.redirect(target);
    const context = { state, verifier, sessionId: auth.session.id, accountId: project.accountId,
      cloudflareAccountId, repo, issuedAt: Date.now() };
    response.cookies.set("fava_cf_oauth", await encryptToken(JSON.stringify(context)), {
      httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "lax",
      path: "/api/cloudflare/oauth", maxAge: 600 });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch {
    return NextResponse.json({ error: "Cloudflare connection could not be started" }, { status: 403 });
  }
}
