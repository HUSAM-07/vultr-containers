import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  if (!clientId || !process.env.GITHUB_APP_CLIENT_SECRET || !process.env.FAVA_SESSION_SECRET ||
    process.env.FAVA_SESSION_SECRET.length < 32)
    return NextResponse.json({ error: "GitHub App is not configured" }, { status: 503 });
  const state = crypto.randomUUID();
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const callback = new URL("/api/github/auth/callback", request.nextUrl.origin).toString();
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", clientId);
  target.searchParams.set("redirect_uri", callback);
  target.searchParams.set("state", state);
  target.searchParams.set("scope", "offline_access");
  target.searchParams.set("code_challenge", challenge);
  target.searchParams.set("code_challenge_method", "S256");
  const response = NextResponse.redirect(target);
  response.cookies.set("fava_oauth", `${state}.${verifier}`, { httpOnly: true,
    secure: request.nextUrl.protocol === "https:", sameSite: "lax", path: "/api/github/auth", maxAge: 600 });
  return response;
}
