import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { readSession, setSession } from "@/lib/fava-session";
import { projectAccess } from "@/lib/fava-db";
import { GitHubError } from "@/lib/fava-github";
import { readJson } from "@/lib/fava-json";
import { changeDevice, listDevices, pairDevice } from "@/lib/fava-devices";

function failure(error: unknown) {
  const status = error instanceof GitHubError && error.status >= 400 && error.status < 500 ? error.status : 502;
  return NextResponse.json({ error: error instanceof GitHubError ? error.message : "Device setup is unavailable" }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const project = await projectAccess(env.DB, auth.session.user.id,
      request.nextUrl.searchParams.get("repo") || "", auth.session.token, "admin");
    const response = NextResponse.json({ devices: await listDevices(env.DB, project.id) });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const body = await readJson(request, 1_000);
    if (!body || typeof body !== "object" || !("repo" in body) || typeof body.repo !== "string" ||
      !("action" in body) || typeof body.action !== "string")
      throw new GitHubError(400, "Invalid device request");
    const project = await projectAccess(env.DB, auth.session.user.id, body.repo, auth.session.token, "admin");
    let result;
    if (body.action === "pair" && "label" in body && typeof body.label === "string")
      result = await pairDevice(env.DB, project.id, auth.session.user.id, body.label);
    else if ((body.action === "rotate" || body.action === "revoke") && "id" in body && typeof body.id === "string")
      result = await changeDevice(env.DB, project.id, auth.session.user.id, body.id, body.action);
    else throw new GitHubError(400, "Invalid device action");
    const response = NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return failure(error); }
}
