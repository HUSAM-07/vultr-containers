export { appJwt } from "../../web/lib/fava-app-jwt.ts";

export function isGitReadRequest(url: URL, method: string, repository: string) {
  const path = `/${repository}.git`;
  return url.protocol === "https:" && url.hostname === "github.com" && (
    method === "GET" && url.pathname === `${path}/info/refs` && url.search === "?service=git-upload-pack" ||
    method === "POST" && url.pathname === `${path}/git-upload-pack` && !url.search
  );
}

export async function installationToken(jwt: string, installationId: number, repositoryId: number,
  access: "read" | "publish" = "read") {
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json",
      "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
    body: JSON.stringify({ repository_ids: [repositoryId], permissions: access === "publish"
      ? { contents: "write", pull_requests: "write" } : { contents: "read" } }),
  });
  if (!response.ok) throw Error(`GitHub installation token request failed: ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string")
    throw Error("GitHub installation token response is invalid");
  return value.token;
}
