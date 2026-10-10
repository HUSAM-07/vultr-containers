import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { GitHubError } from "@/lib/fava-github";
import { readJson } from "@/lib/fava-json";
import { authenticateDevice, claimLocalRun, failLocalRun, localRunSkills, renewLocalRun, submitLocalRun } from "@/lib/fava-local-runs";

export async function POST(request: NextRequest) {
  try {
    const device = await authenticateDevice(env.DB, request.headers.get("authorization"));
    const body = await readJson(request, 1_300_000);
    if (!body || typeof body !== "object" || !("action" in body) || typeof body.action !== "string")
      throw new GitHubError(400, "Invalid device run request");
    let result;
    if (body.action === "claim") result = await claimLocalRun(env.DB, device);
    else if (body.action === "skills" && "runId" in body && typeof body.runId === "string" &&
      "leaseId" in body && typeof body.leaseId === "string")
      result = await localRunSkills(env.DB, device, body.runId, body.leaseId,
        process.env.GITHUB_APP_CLIENT_ID || "", process.env.GITHUB_APP_PRIVATE_KEY || "");
    else if (body.action === "heartbeat" && "runId" in body && typeof body.runId === "string" &&
      "leaseId" in body && typeof body.leaseId === "string")
      result = await renewLocalRun(env.DB, device, body.runId, body.leaseId);
    else if (body.action === "submit" && "runId" in body && "leaseId" in body &&
      "patch" in body && "summary" in body && "stdout" in body && "stderr" in body)
      result = await submitLocalRun(env.DB, env.ARTIFACTS, device, body as Parameters<typeof submitLocalRun>[3]);
    else if (body.action === "fail" && "runId" in body && typeof body.runId === "string" &&
      "leaseId" in body && typeof body.leaseId === "string" &&
      "message" in body && typeof body.message === "string")
      result = await failLocalRun(env.DB, device, body.runId, body.leaseId, body.message);
    else throw new GitHubError(400, "Invalid device run action");
    return NextResponse.json(result || { pending: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 502;
    return NextResponse.json({ error: error instanceof GitHubError ? error.message : "Local run service is unavailable" },
      { status, headers: { "Cache-Control": "no-store" } });
  }
}
