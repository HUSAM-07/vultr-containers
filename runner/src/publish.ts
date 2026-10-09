import { appJwt, installationToken } from "./github.ts";
import type { Env } from "./types";

export type Upload = { path: string; mode: "100644" | "100755"; content: string | null };
export type PublishRun = { id: string; repository: string; repositoryId: number; installationId: number;
  sha: string; defaultBranch: string; specPath: string; specPullNumber: number };

async function github<T>(token: string, path: string, method = "GET", body?: unknown, optional = false): Promise<T | null> {
  const response = await fetch(`https://api.github.com${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw Error(`GitHub ${method} ${path} failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export async function publishImplementation(env: Env, run: PublishRun, files: Upload[], summary: string) {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(run.repository) ||
    !/^[a-f0-9]{40}$/i.test(run.sha) || !/^[a-f0-9-]{36}$/.test(run.id) || files.length === 0)
    throw Error("Invalid implementation source");
  const token = await installationToken(appJwt(env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_PRIVATE_KEY),
    run.installationId, run.repositoryId, "publish");
  const prefix = `/repos/${run.repository}`;
  const branch = `impl/${run.id}`;
  const marker = `Fava run ${run.id}`;
  const base = await github<{ tree: { sha: string } }>(token, `${prefix}/git/commits/${run.sha}`);
  if (!base) throw Error("Merged specification commit is unavailable");
  const tree = [];
  for (const file of files) {
    if (file.content === null) {
      tree.push({ path: file.path, mode: file.mode, type: "blob", sha: null });
    } else {
      const blob = await github<{ sha: string }>(token, `${prefix}/git/blobs`, "POST",
        { content: file.content, encoding: "base64" });
      if (!blob) throw Error(`Could not upload ${file.path}`);
      tree.push({ path: file.path, mode: file.mode, type: "blob", sha: blob.sha });
    }
  }
  const nextTree = await github<{ sha: string }>(token, `${prefix}/git/trees`, "POST",
    { base_tree: base.tree.sha, tree });
  if (!nextTree) throw Error("Could not create implementation tree");
  let ref = await github<{ object: { sha: string } }>(token, `${prefix}/git/ref/heads/${branch}`, "GET", undefined, true);
  if (ref) {
    const commit = await github<{ message: string; parents: { sha: string }[]; tree: { sha: string } }>(token,
      `${prefix}/git/commits/${ref.object.sha}`);
    if (!commit?.message.includes(marker) || commit.parents.length !== 1 || commit.parents[0].sha !== run.sha ||
      commit.tree.sha !== nextTree.sha)
      throw Error("Implementation branch was changed outside this run");
  } else {
    const commit = await github<{ sha: string }>(token, `${prefix}/git/commits`, "POST",
      { message: `impl: spec #${run.specPullNumber}\n\n${marker}`, tree: nextTree.sha, parents: [run.sha] });
    if (!commit) throw Error("Could not create implementation commit");
    await github(token, `${prefix}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
    ref = { object: { sha: commit.sha } };
  }
  const [owner] = run.repository.split("/");
  const pulls = await github<{ number: number; html_url: string; state: string; head: { ref: string; sha: string };
    base: { ref: string } }[]>(token,
    `${prefix}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
  const existing = pulls?.find(pull => pull.head.ref === branch && pull.base.ref === run.defaultBranch);
  if (existing) {
    if (existing.state !== "open" || existing.head.sha !== ref.object.sha)
      throw Error("Implementation pull request changed outside this run");
    return { branch, pullNumber: existing.number, url: existing.html_url };
  }
  const pull = await github<{ number: number; html_url: string }>(token, `${prefix}/pulls`, "POST", {
    title: `impl: spec #${run.specPullNumber}`, head: branch, base: run.defaultBranch, draft: true,
    body: `Implements [spec #${run.specPullNumber}](https://github.com/${run.repository}/pull/${run.specPullNumber}) from \`${run.specPath}\`.\n\n` +
      `Pinned source: \`${run.sha}\`\n\nRun: \`${run.id}\`\n\nAgent summary:\n${summary.slice(0, 1000)}\n\n` +
      "Automated spec review passed. Inspect the review report and run artifacts in Fava before approving this draft.",
  });
  if (!pull) throw Error("Could not open implementation pull request");
  return { branch, pullNumber: pull.number, url: pull.html_url };
}
