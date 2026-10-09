export type Repository = { id: number; fullName: string; private: boolean; defaultBranch: string; htmlUrl: string; canPush: boolean };

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function parseRepo(value: string) {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value) ||
    value.endsWith(".git") || [".", ".."].includes(value.split("/")[1]))
    throw new GitHubError(400, "Choose a valid GitHub repository");
  return value;
}

export function slug(title: string) {
  const value = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55).replace(/-$/, "");
  if (!value) throw new GitHubError(400, "Give the specification a descriptive title");
  return value;
}

function base64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

export function validateSpec(title: string, content: string) {
  const cleanTitle = title.trim();
  const cleanContent = content.trim();
  if (cleanTitle.length < 5 || cleanTitle.length > 120 || cleanContent.length < 80 || cleanContent.length > 40_000)
    throw new GitHubError(400, "Use a 5–120 character title and 80–40,000 character specification");
  const sections = cleanContent.split(/^## /m).slice(1).map(block => {
    const [name, ...body] = block.split("\n");
    return { name: name.trim().toLowerCase(), body: body.join("\n").trim() };
  });
  for (const heading of ["Outcome", "Scope", "Acceptance criteria"]) {
    if (!sections.some(section => section.name === heading.toLowerCase() && section.body.length >= 20))
      throw new GitHubError(400, `Add a concrete ${heading.toLowerCase()} section`);
  }
  if (cleanContent.includes("Describe the result a user should experience") ||
    cleanContent.includes("Describe what must be built") ||
    cleanContent.includes("Describe an observable behavior"))
    throw new GitHubError(400, "Replace the template guidance with your own specification");
  return { title: cleanTitle, content: cleanContent };
}

export async function github<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch("https://api.github.com" + path, {
    method, headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, cache: "no-store",
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new GitHubError(response.status, typeof value.message === "string" ? value.message : "GitHub request failed");
  }
  return response.json() as Promise<T>;
}

type GitHubRepo = { id: number; full_name: string; private: boolean; default_branch: string; html_url: string;
  permissions?: { push?: boolean } };

export async function listRepositories(token: string): Promise<Repository[]> {
  const { installations } = await github<{ installations: { id: number }[] }>(token, "/user/installations?per_page=100");
  const pages = await Promise.all(installations.slice(0, 20).map(async installation => {
    const { repositories } = await github<{ repositories: GitHubRepo[] }>(token,
      `/user/installations/${installation.id}/repositories?per_page=100`);
    return repositories;
  }));
  return pages.flat().map(repo => ({ id: repo.id, fullName: repo.full_name, private: repo.private,
    defaultBranch: repo.default_branch, htmlUrl: repo.html_url, canPush: Boolean(repo.permissions?.push) }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function importContext(token: string, name: string) {
  const repo = parseRepo(name);
  const metadata = await github<GitHubRepo>(token, `/repos/${repo}`);
  const tree = await github<{ tree: { path: string; type: string }[]; truncated: boolean }>(token,
    `/repos/${repo}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`);
  const paths = tree.tree.filter(item => item.type === "blob").map(item => item.path);
  const candidates = ["README.md", "AGENTS.md", "package.json", "pyproject.toml", "Cargo.toml",
    "docs/architecture.md", "docs/README.md", "specs/README.md"];
  const files = await Promise.all(candidates.filter(path => paths.includes(path)).slice(0, 5).map(async path => {
    const file = await github<{ content: string; encoding: string; size: number }>(token,
      `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(metadata.default_branch)}`);
    if (file.encoding !== "base64" || file.size > 50_000) return null;
    const binary = atob(file.content.replace(/\s/g, ""));
    return { path, text: new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0))) };
  }));
  return { repository: repo, defaultBranch: metadata.default_branch, paths: paths.slice(0, 400),
    truncated: tree.truncated || paths.length > 400, files: files.filter(file => file !== null) };
}

export async function publishSpec(token: string, name: string, title: string, content: string) {
  const repo = parseRepo(name);
  const { title: cleanTitle, content: cleanContent } = validateSpec(title, content);
  const metadata = await github<GitHubRepo>(token, `/repos/${repo}`);
  if (!metadata.permissions?.push) throw new GitHubError(403, "Your GitHub account cannot push to this repository");
  const specId = crypto.randomUUID().slice(0, 8);
  const branch = `spec/${slug(cleanTitle)}-${specId}`;
  const base = metadata.default_branch;
  const head = await github<{ commit: { sha: string } }>(token,
    `/repos/${repo}/branches/${encodeURIComponent(base)}`);
  await github(token, `/repos/${repo}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: head.commit.sha });
  const path = `specs/${slug(cleanTitle)}-${specId}.md`;
  try {
    const encoded = base64(`# ${cleanTitle}\n\n${cleanContent}\n`);
    await github(token, `/repos/${repo}/contents/${path}`, "PUT", { message: `spec: ${cleanTitle}`,
      content: encoded, branch });
    const pull = await github<{ html_url: string; number: number }>(token, `/repos/${repo}/pulls`, "POST", {
      title: `spec: ${cleanTitle}`, head: branch, base,
      body: `Specification proposal for \`${path}\`. Agent implementation starts only after this specification is merged.`,
    });
    return { url: pull.html_url, number: pull.number, branch, path };
  } catch (error) {
    throw new GitHubError(error instanceof GitHubError ? error.status : 502,
      `Spec branch ${branch} was created, but publishing did not finish: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
