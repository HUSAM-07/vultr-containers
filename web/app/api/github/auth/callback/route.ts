import { NextRequest, NextResponse } from "next/server";
import { github } from "@/lib/fava-github";
import { setSession } from "@/lib/fava-session";

export async function GET(request: NextRequest) {
  const [state, verifier] = (request.cookies.get("fava_oauth")?.value || "").split(".");
  const supplied = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  if (!state || !verifier || !supplied || state !== supplied || !code)
    return NextResponse.json({ error: "GitHub sign-in could not be verified. Try again." }, { status: 400 });
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return NextResponse.json({ error: "GitHub App is not configured" }, { status: 503 });
  try {
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code,
        redirect_uri: new URL("/api/github/auth/callback", request.nextUrl.origin).toString(), code_verifier: verifier }),
      cache: "no-store",
    });
    if (!tokenResponse.ok) throw Error("Token exchange failed");
    const token = await tokenResponse.json();
    if (typeof token.access_token !== "string" || typeof token.expires_in !== "number")
      throw Error("GitHub did not issue an expiring access token");
    const user = await github<{ id: number; login: string; avatar_url: string }>(token.access_token, "/user");
    const response = NextResponse.redirect(new URL("/app", request.nextUrl.origin));
    await setSession(response, request, { token: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      refreshToken: token.refresh_token,
      refreshExpiresAt: token.refresh_token_expires_in ? Date.now() + token.refresh_token_expires_in * 1000 : undefined,
      user: { id: user.id, login: user.login, avatarUrl: user.avatar_url } });
    response.cookies.set("fava_oauth", "", { httpOnly: true, sameSite: "lax", path: "/api/github/auth", maxAge: 0 });
    return response;
  } catch {
    return NextResponse.json({ error: "GitHub sign-in failed. Try again." }, { status: 502 });
  }
}
