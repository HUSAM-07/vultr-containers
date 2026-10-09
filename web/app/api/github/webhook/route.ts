import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { GitHubError } from "@/lib/fava-github";
import { readBytes } from "@/lib/fava-json";
import { processPullRequestEvent, verifyWebhookSignature } from "@/lib/fava-webhook";

export async function POST(request: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !env.DB) return NextResponse.json({ error: "GitHub webhook is not configured" }, { status: 503 });
  try {
    const bytes = await readBytes(request, 1_000_000);
    if (!verifyWebhookSignature(secret, bytes, request.headers.get("x-hub-signature-256")))
      return NextResponse.json({ error: "Invalid GitHub signature" }, { status: 401 });
    if (request.headers.get("x-github-event") !== "pull_request") return new Response(null, { status: 204 });
    const deliveryId = request.headers.get("x-github-delivery") || "";
    if (!/^[a-z0-9-]{1,100}$/i.test(deliveryId))
      return NextResponse.json({ error: "Invalid delivery ID" }, { status: 400 });
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new GitHubError(400, "Invalid webhook JSON"); }
    if (!payload || typeof payload !== "object") throw new GitHubError(400, "Invalid webhook JSON");
    const result = await processPullRequestEvent(env.DB, payload, deliveryId,
      { clientId: process.env.GITHUB_APP_CLIENT_ID, privateKey: process.env.GITHUB_APP_PRIVATE_KEY });
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 502;
    return NextResponse.json({ error: error instanceof GitHubError ? error.message : "Webhook processing failed" }, { status });
  }
}
