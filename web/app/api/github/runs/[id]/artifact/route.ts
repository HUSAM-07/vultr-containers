import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { readSession, setSession } from "@/lib/fava-session";
import { projectAccess } from "@/lib/fava-db";

const names = { diff: "diff.patch", review: "review.json", stdout: "stdout.log", stderr: "stderr.log" } as const;

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const kind = request.nextUrl.searchParams.get("kind") || "diff";
  if (!/^[a-f0-9-]{36}$/.test(id) || !(kind in names))
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!env.DB || !env.ARTIFACTS)
    return NextResponse.json({ error: "Run artifacts are not configured" }, { status: 503 });
  const auth = await readSession(request, env.DB);
  if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
  const run = await env.DB.prepare("SELECT runs.artifact_key AS artifactKey, projects.id AS projectId, projects.full_name AS repository FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE runs.id = ?")
    .bind(id).first<{ artifactKey: string | null; projectId: string; repository: string }>();
  if (!run?.artifactKey || run.artifactKey !== `runs/${id}`)
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  try {
    await projectAccess(env.DB, auth.session.user.id, run.repository, auth.session.token, "viewer", run.projectId);
  } catch { return NextResponse.json({ error: "Artifact not found" }, { status: 404 }); }
  const object = await env.ARTIFACTS.get(`${run.artifactKey}/${names[kind as keyof typeof names]}`);
  if (!object) return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  const response = new NextResponse(object.body, { headers: {
    "Content-Type": kind === "diff" ? "text/x-diff; charset=utf-8" : kind === "review" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
  if (auth.refreshed) await setSession(response, request, auth.session);
  return response;
}
