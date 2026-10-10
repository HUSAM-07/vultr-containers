import { NextRequest, NextResponse } from "next/server";
import { GitHubError, importContext } from "@/lib/fava-github";
import { importPublicGitContext, readPublicGitFile } from "@/lib/fava-public-context";

export async function GET(request: NextRequest) {
  const repo = request.nextUrl.searchParams.get("repo") || "";
  const action = request.nextUrl.searchParams.get("action") || "context";
  try {
    const value = action === "context" ? await importContext("", repo, true).catch(error => {
      if (error instanceof GitHubError && (error.status === 403 || error.status === 429))
        return importPublicGitContext(repo);
      throw error;
    }) : action === "file" ? await readPublicGitFile(repo,
      request.nextUrl.searchParams.get("path") || "", request.nextUrl.searchParams.get("ref") || "")
      : null;
    return value ? NextResponse.json(value) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    const rateLimited = error instanceof GitHubError && error.status === 403 && /rate limit/i.test(error.message);
    const status = rateLimited ? 429 : error instanceof GitHubError && error.status < 500 ? error.status : 502;
    return NextResponse.json({ error: rateLimited
      ? "GitHub is limiting public imports right now. Your draft is saved; connect GitHub or try again later."
      : error instanceof GitHubError ? error.message : "GitHub is unavailable" }, { status });
  }
}
