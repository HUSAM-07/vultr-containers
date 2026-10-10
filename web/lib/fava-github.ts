import { specValidationError } from "./fava-criteria.ts";

export type Repository = { id: number; fullName: string; private: boolean; defaultBranch: string; htmlUrl: string; canPush: boolean; installationId: number };

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

export function validSkillPath(path: string) {
  return /^\.fava\/skills\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md$/.test(path);
}

export async function listSkillFiles(token: string, name: string, ref: string) {
  const repo = parseRepo(name);
  try {
    const files = await github<{ path: string; type: string; size: number }[]>(token,
      `/repos/${repo}/contents/.fava/skills?ref=${encodeURIComponent(ref)}`);
    if (!Array.isArray(files)) throw new GitHubError(400, "Expected a .fava/skills directory");
    return files.filter(file => file.type === "file" && validSkillPath(file.path) && file.size >= 20 && file.size <= 12_000)
      .map(file => ({ path: file.path, size: file.size }));
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return [];
    throw error;
  }
}

export async function readSkillFile(token: string, name: string, path: string, sha: string) {
  const repo = parseRepo(name);
  if (!validSkillPath(path) || !/^[a-f0-9]{40}$/i.test(sha)) throw new GitHubError(400, "Invalid skill source");
  const file = await github<{ content: string; encoding: string; size: number }>(token,
    `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`);
  if (file.encoding !== "base64" || file.size < 20 || file.size > 12_000)
    throw new GitHubError(400, "Skill must be a 20–12,000 byte Markdown file");
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(file.content.replace(/\s/g, "")), character => character.charCodeAt(0)));
    if (new TextEncoder().encode(content).length !== file.size) throw Error("Size mismatch");
    return content;
  } catch { throw new GitHubError(400, "Skill file must contain valid UTF-8 Markdown"); }
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
  const error = specValidationError(cleanTitle, cleanContent);
  if (error) throw new GitHubError(400, error);
  return { title: cleanTitle, content: cleanContent };
}

export async function github<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch("https://api.github.com" + path, {
    method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, cache: "no-store",
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({})) as { message?: unknown };
    throw new GitHubError(response.status, typeof value.message === "string" ? value.message : "GitHub request failed");
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

type GitHubRepo = { id: number; full_name: string; private: boolean; default_branch: string; html_url: string;
  permissions?: { push?: boolean } };
type GitHubContentFile = { content?: string; encoding?: string; size?: number };

function decodeTextFile(file: GitHubContentFile | null) {
  if (!file || file.encoding !== "base64" || typeof file.content !== "string" ||
    typeof file.size !== "number" || !Number.isSafeInteger(file.size) ||
    file.size < 0 || file.size > 50_000 || file.content.length > 70_000)
    return null;
  try {
    const binary = atob(file.content.replace(/\s/g, ""));
    if (binary.length !== file.size) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, character => character.charCodeAt(0)));
  } catch { return null; }
}

export async function readContextFile(token: string, name: string, path: string, sha: string, publicOnly = false) {
  const repo = parseRepo(name);
  if (!/^[a-f0-9]{40}$/i.test(sha) || path.length > 500 || !path.split("/").every(segment =>
    segment && segment !== "." && segment !== ".." && !/[\\\x00-\x1f\x7f]/.test(segment)))
    throw new GitHubError(400, "Choose a valid file from the imported commit");
  if (publicOnly) {
    const metadata = await github<GitHubRepo>(token, `/repos/${repo}`);
    if (metadata.private !== false) throw new GitHubError(403, "Connect GitHub to read a private repository");
  }
  const file = await github<GitHubContentFile>(token,
    `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`);
  const text = decodeTextFile(file);
  if (text === null) throw new GitHubError(422, "Only UTF-8 files up to 50 KB can be inspected");
  return { path, text };
}

export async function createRepository(token: string, owner: string, name: string, isPrivate: boolean) {
  const fullName = parseRepo(`${owner}/${name.trim()}`);
  const created = await github<GitHubRepo>(token, "/user/repos", "POST", {
    name: fullName.split("/")[1], private: isPrivate, auto_init: true,
  });
  if (!Number.isSafeInteger(created.id) || created.id <= 0 ||
    created.full_name?.toLowerCase() !== fullName.toLowerCase())
    throw new GitHubError(502, "GitHub returned an unexpected repository; check your GitHub account before retrying");
  return { id: created.id, fullName: created.full_name, htmlUrl: `https://github.com/${fullName}` };
}

async function pages<T>(token: string, path: string, field: "installations" | "repositories", maxPages: number) {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await github<{ total_count?: number; installations?: T[]; repositories?: T[] }>(token,
      `${path}?per_page=100${page === 1 ? "" : `&page=${page}`}`);
    const chunk = result[field];
    if (!Array.isArray(chunk)) throw new GitHubError(502, "GitHub returned an invalid repository listing");
    items.push(...chunk);
    if (chunk.length < 100 || Number.isSafeInteger(result.total_count) && items.length >= result.total_count!)
      return items;
  }
  // shortcut: enumerate at most 2,000 installations or 2,000 repositories per installation; add server-side search for larger accounts.
  throw new GitHubError(422, "This GitHub account has too many repositories to list; narrow the App installation");
}

export async function addCreatedRepositoryToInstallation(token: string, owner: string, repositoryId: number) {
  const installations = await pages<{ id: number; account: { login: string }; target_type: string;
    repository_selection: string }>(token, "/user/installations", "installations", 20);
  const installation = installations.find(item => item.target_type === "User" &&
    item.account?.login?.toLowerCase() === owner.toLowerCase());
  if (!installation) return false;
  if (!Number.isSafeInteger(installation.id) || installation.id <= 0)
    throw new GitHubError(502, "GitHub returned an invalid App installation");
  if (installation.repository_selection === "selected")
    await github<void>(token, `/user/installations/${installation.id}/repositories/${repositoryId}`, "PUT");
  return true;
}

export async function listRepositories(token: string): Promise<Repository[]> {
  const installations = await pages<{ id: number }>(token, "/user/installations", "installations", 20);
  const found: Repository[] = [];
  for (let index = 0; index < installations.length; index += 8) {
    const batch = await Promise.all(installations.slice(index, index + 8).map(async installation => {
      const repositories = await pages<GitHubRepo>(token,
        `/user/installations/${installation.id}/repositories`, "repositories", 20);
      return repositories.map(repo => ({ id: repo.id, fullName: repo.full_name, private: repo.private,
      defaultBranch: repo.default_branch, htmlUrl: repo.html_url, canPush: Boolean(repo.permissions?.push),
        installationId: installation.id }));
    }));
    found.push(...batch.flat());
  }
  return found.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function importContext(token: string, name: string, publicOnly = false) {
  const repo = parseRepo(name);
  const metadata = await github<GitHubRepo>(token, `/repos/${repo}`);
  if (publicOnly && metadata.private !== false)
    throw new GitHubError(403, "Connect GitHub to import a private repository");
  const head = await github<{ commit: { sha: string } }>(token,
    `/repos/${repo}/branches/${encodeURIComponent(metadata.default_branch)}`);
  if (!/^[a-f0-9]{40}$/i.test(head.commit?.sha || ""))
    throw new GitHubError(502, "GitHub returned an invalid branch commit");
  const commitSha = head.commit.sha;
  const tree = await github<{ tree: { path: string; type: string }[]; truncated: boolean }>(token,
    `/repos/${repo}/git/trees/${commitSha}?recursive=1`);
  const paths = tree.tree.filter(item => item.type === "blob").map(item => item.path);
  const nestedInstructions = paths.filter(path =>
    /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/){1,3}(?:AGENTS|CLAUDE|GEMINI)\.md$/.test(path))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const candidates = ["README.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md",
    ".github/copilot-instructions.md", ...nestedInstructions, "package.json", "pyproject.toml",
    "Cargo.toml", "docs/architecture.md", "docs/README.md", "specs/README.md"];
  const files = await Promise.all(candidates.filter(path => paths.includes(path)).slice(0, 8).map(async path => {
    const file = await github<GitHubContentFile>(token,
      `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commitSha}`);
    const text = decodeTextFile(file);
    return text === null ? null : { path, text };
  }));
  // shortcut: GitHub truncates recursive trees above 100,000 entries or 7 MB; walk subtrees when that affects users.
  return { repository: repo, defaultBranch: metadata.default_branch, commitSha, paths,
    truncated: tree.truncated, files: files.filter(file => file !== null) };
}

export async function listSpecPullRequests(token: string, name: string) {
  const repo = parseRepo(name);
  const metadata = await github<GitHubRepo>(token, `/repos/${repo}`);
  const pulls = await github<{ number: number; title: string; html_url: string; state: string;
    merged_at: string | null; merge_commit_sha: string | null; head: { ref: string }; base: { ref: string } }[]>(token,
    `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=50`);
  const candidates = pulls.filter(pull => pull.head.ref.startsWith("spec/") &&
    pull.base.ref === metadata.default_branch).slice(0, 10);
  const proposals = await Promise.all(candidates.map(async pull => {
    const files = await github<{ filename: string; status: string }[]>(token,
      `/repos/${repo}/pulls/${pull.number}/files?per_page=100`);
    if (files.length !== 1 || files[0].status !== "added" ||
      !/^specs\/[a-z0-9][a-z0-9-]*\.md$/.test(files[0].filename)) return null;
    return { number: pull.number, title: pull.title, url: pull.html_url, path: files[0].filename,
      status: pull.merged_at && pull.merge_commit_sha ? "merged" : pull.state === "open" ? "open" : "closed",
      mergedCommitSha: pull.merged_at ? pull.merge_commit_sha : null };
  }));
  return proposals.filter(proposal => proposal !== null);
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
