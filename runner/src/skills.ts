import { readSkillFile, validSkillPath } from "../../web/lib/fava-github.ts";
import { appJwt, installationToken } from "./github.ts";
import type { Env } from "./types.ts";

type PinnedSkill = { path: string; commitSha: string; repository: string | null;
  repositoryId: number | null; installationId: number | null };

export async function loadRunSkills(env: Env, runId: string) {
  const found = await env.DB.prepare("SELECT skills.path, run_skills.commit_sha AS commitSha, source.full_name AS repository, source.github_repo_id AS repositoryId, source.installation_id AS installationId FROM run_skills JOIN skills ON skills.id = run_skills.skill_id JOIN runs ON runs.id = run_skills.run_id JOIN specs ON specs.id = runs.spec_id JOIN projects AS target ON target.id = specs.project_id LEFT JOIN projects AS source ON source.account_id = target.account_id AND source.github_repo_id = skills.source_repo_id WHERE run_skills.run_id = ? AND skills.account_id = target.account_id ORDER BY skills.project_id IS NULL DESC, skills.path LIMIT 9")
    .bind(runId).all<PinnedSkill>();
  if (found.results.length > 8) throw Error("Run has more than eight pinned skills");
  if (!found.results.length) return "";
  const tokens = new Map<number, string>();
  const jwt = appJwt(env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_PRIVATE_KEY);
  const blocks = [];
  for (const skill of found.results) {
    if (!validSkillPath(skill.path) || !/^[a-f0-9]{40}$/i.test(skill.commitSha) ||
      !skill.repository || !skill.repositoryId || !skill.installationId)
      throw Error("Pinned skill source is unavailable");
    let token = tokens.get(skill.repositoryId);
    if (!token) {
      token = await installationToken(jwt, skill.installationId, skill.repositoryId);
      tokens.set(skill.repositoryId, token);
    }
    const content = await readSkillFile(token, skill.repository, skill.path, skill.commitSha);
    blocks.push(`### ${skill.repository}@${skill.commitSha}:${skill.path}\n${content}`);
  }
  return blocks.join("\n\n");
}
