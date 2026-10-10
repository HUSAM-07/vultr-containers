import { GitHubError, parseRepo } from "./fava-github.ts";

async function readLimited(stream: ReadableStream<Uint8Array> | null, limit: number,
  tooLarge = "Public repository is too large for quick import; connect GitHub to import it") {
  if (!stream) throw new GitHubError(502, "GitHub returned an empty response");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new GitHubError(413, tooLarge);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function tarText(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes).split("\0", 1)[0];
}

export async function importPublicGitContext(name: string) {
  const repo = parseRepo(name);
  const refs = await fetch(`https://github.com/${repo}.git/info/refs?service=git-upload-pack`, { cache: "no-store" });
  if (!refs.ok) throw new GitHubError(refs.status === 404 ? 404 : 502, "Public repository is unavailable; connect GitHub to import it");
  const advertised = new TextDecoder().decode(await readLimited(refs.body, 65_536));
  const head = advertised.match(/([a-f0-9]{40}) HEAD\0[^\n]*\bsymref=HEAD:refs\/heads\/([^\s]+)/);
  if (!head) throw new GitHubError(422, "Repository has no importable default branch");
  const [, commitSha, defaultBranch] = head;
  const archive = await fetch(`https://codeload.github.com/${repo}/tar.gz/${commitSha}`, { cache: "no-store" });
  if (!archive.ok) throw new GitHubError(502, "Could not download the public repository");
  const compressed = await readLimited(archive.body, 8_000_000);
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b)
    throw new GitHubError(502, "GitHub returned an invalid repository archive");
  let tar: Uint8Array;
  try {
    tar = await readLimited(new Blob([compressed.buffer]).stream()
      .pipeThrough(new DecompressionStream("gzip")), 32_000_000);
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError(502, "GitHub returned an invalid repository archive");
  }
  const paths: string[] = [];
  const contents = new Map<string, string>();
  let truncated = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = Number.parseInt(tarText(header.subarray(124, 136)).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new GitHubError(502, "GitHub returned an invalid repository archive");
    const start = offset + 512;
    const next = start + Math.ceil(size / 512) * 512;
    if (next > tar.length) throw new GitHubError(502, "GitHub returned an incomplete repository archive");
    const fullPath = [tarText(header.subarray(345, 500)), tarText(header.subarray(0, 100))].filter(Boolean).join("/");
    const path = fullPath.slice(fullPath.indexOf("/") + 1);
    if ((header[156] === 0 || header[156] === 48) && fullPath.includes("/") && path &&
      path.length <= 500 && path.split("/").every(segment => segment && segment !== "." && segment !== ".." &&
        !/[\\\x00-\x1f\x7f]/.test(segment))) {
      if (paths.length < 10_000) paths.push(path);
      else truncated = true;
      if (size <= 50_000 && /^(?:README\.md|AGENTS\.md|CLAUDE\.md|GEMINI\.md|package\.json|pyproject\.toml|Cargo\.toml|\.github\/copilot-instructions\.md|docs\/(?:architecture|README)\.md|specs\/README\.md|(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/){1,3}(?:AGENTS|CLAUDE|GEMINI)\.md)$/.test(path)) {
        try { contents.set(path, new TextDecoder("utf-8", { fatal: true }).decode(tar.subarray(start, start + size))); }
        catch { /* Binary instruction files are not useful context. */ }
      }
    } else if (header[156] !== 53 && header[156] !== 103) truncated = true;
    offset = next;
  }
  const candidates = ["README.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md",
    ...paths.filter(path => /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/){1,3}(?:AGENTS|CLAUDE|GEMINI)\.md$/.test(path))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)),
    "package.json", "pyproject.toml", "Cargo.toml", "docs/architecture.md", "docs/README.md", "specs/README.md"];
  return { repository: repo, defaultBranch, commitSha, paths, truncated,
    files: candidates.filter(path => paths.includes(path) && contents.has(path)).slice(0, 8)
      .map(path => ({ path, text: contents.get(path)! })) };
}

export async function readPublicGitFile(name: string, path: string, sha: string) {
  const repo = parseRepo(name);
  if (!/^[a-f0-9]{40}$/i.test(sha) || path.length > 500 || !path.split("/").every(segment =>
    segment && segment !== "." && segment !== ".." && !/[\\\x00-\x1f\x7f]/.test(segment)))
    throw new GitHubError(400, "Choose a valid file from the imported commit");
  const url = `https://raw.githubusercontent.com/${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new GitHubError(response.status === 404 ? 404 : 502, "Public file is unavailable");
  const bytes = await readLimited(response.body, 50_000, "Only UTF-8 files up to 50 KB can be inspected");
  try { return { path, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
  catch { throw new GitHubError(422, "Only UTF-8 files up to 50 KB can be inspected"); }
}
