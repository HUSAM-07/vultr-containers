import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/runtime-env";
import { readSession, setSession } from "@/lib/fava-session";
import { github, GitHubError, listRepositories, listSkillFiles, parseRepo, publishSkill, readSkillFile, validSkillPath } from "@/lib/fava-github";
import { readJson } from "@/lib/fava-json";
import { projectAccess } from "@/lib/fava-db";

function fail(error: unknown) {
  return NextResponse.json({ error: error instanceof GitHubError ? error.message : "Skill library is unavailable" },
    { status: error instanceof GitHubError ? error.status : 502 });
}

export async function GET(request: NextRequest) {
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const repository = request.nextUrl.searchParams.get("repo") || "";
    const project = await projectAccess(env.DB, auth.session.user.id, repository, auth.session.token);
    const [available, selected] = await Promise.all([
      listSkillFiles(auth.session.token, repository, project.defaultBranch),
      env.DB.prepare("SELECT skills.id, skills.path, skills.commit_sha AS commitSha, skills.project_id AS projectId, source.full_name AS sourceRepository FROM skills JOIN projects AS source ON source.account_id = skills.account_id AND source.github_repo_id = skills.source_repo_id WHERE skills.account_id = ? AND skills.active = 1 AND (skills.project_id IS NULL OR skills.project_id = ?) ORDER BY skills.project_id IS NULL DESC, skills.path")
        .bind(project.accountId, project.id)
        .all<{ id: string; path: string; commitSha: string; projectId: string | null; sourceRepository: string }>(),
    ]);
    const response = NextResponse.json({ available, selected: selected.results });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return fail(error); }
}

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  try {
    const auth = await readSession(request, env.DB);
    if (!auth) return NextResponse.json({ error: "Connect GitHub to continue" }, { status: 401 });
    const body = await readJson(request, 50_000);
    if (!body || typeof body !== "object" || !("repo" in body) || typeof body.repo !== "string" ||
      !("action" in body) || typeof body.action !== "string") throw new GitHubError(400, "Invalid skill request");
    const project = await projectAccess(env.DB, auth.session.user.id, body.repo, auth.session.token, "editor");
    const accountId = project.accountId;
    const canManageWorkspace = project.accountRole === "owner" || project.accountRole === "admin";
    if (body.action === "propose") {
      if (!("name" in body) || typeof body.name !== "string" ||
        !("content" in body) || typeof body.content !== "string")
        throw new GitHubError(400, "Give the skill a name and instructions");
      const proposal = await publishSkill(auth.session.token, project.repository, body.name, body.content);
      const response = NextResponse.json(proposal, { status: 201 });
      if (auth.refreshed) await setSession(response, request, auth.session);
      return response;
    }
    if (body.action === "remove") {
      if (!("id" in body) || typeof body.id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.id))
        throw new GitHubError(400, "Choose a selected skill");
      const skill = await env.DB.prepare("SELECT project_id AS projectId FROM skills WHERE id = ? AND account_id = ?")
        .bind(body.id, accountId).first<{ projectId: string | null }>();
      if (!skill || skill.projectId && skill.projectId !== project.id ||
        skill.projectId === null && !canManageWorkspace)
        throw new GitHubError(403, "You cannot remove this skill");
      await env.DB.prepare("UPDATE skills SET active = 0 WHERE id = ? AND account_id = ?")
        .bind(body.id, accountId).run();
    } else if (body.action === "add") {
      if (!("path" in body) || typeof body.path !== "string" || !validSkillPath(body.path) ||
        !("scope" in body) || (body.scope !== "project" && body.scope !== "workspace"))
        throw new GitHubError(400, "Choose a valid skill and scope");
      if (body.scope === "workspace" && !canManageWorkspace)
        throw new GitHubError(403, "Only workspace administrators can add shared skills");
      const name = body.repo;
      const repository = (await listRepositories(auth.session.token)).find(item =>
        item.fullName.toLowerCase() === name.toLowerCase() && item.id === project.githubRepoId);
      if (!repository) throw new GitHubError(403, "The Fava GitHub App no longer has access to this repository");
      const scopedProject = body.scope === "project" ? project.id : null;
      const prior = await env.DB.prepare("SELECT active FROM skills WHERE account_id = ? AND project_id IS ? AND source_repo_id = ? AND path = ?")
        .bind(accountId, scopedProject, repository.id, body.path).first<{ active: number }>();
      if (!prior?.active) {
        const count = scopedProject
          ? await env.DB.prepare("SELECT COUNT(*) AS count FROM skills WHERE account_id = ? AND active = 1 AND (project_id IS NULL OR project_id = ?)")
            .bind(accountId, project.id).first<{ count: number }>()
          : await env.DB.prepare("SELECT COALESCE(MAX(skill_count), 0) AS count FROM (SELECT COUNT(skills.id) AS skill_count FROM projects LEFT JOIN skills ON skills.account_id = projects.account_id AND skills.active = 1 AND (skills.project_id IS NULL OR skills.project_id = projects.id) WHERE projects.account_id = ? GROUP BY projects.id)")
            .bind(accountId).first<{ count: number }>();
        if ((count?.count || 0) >= 8) throw new GitHubError(400, "Each project can use at most eight selected skills");
      }
      const branch = await github<{ commit: { sha: string } }>(auth.session.token,
        `/repos/${parseRepo(name)}/branches/${encodeURIComponent(project.defaultBranch)}`);
      await readSkillFile(auth.session.token, name, body.path, branch.commit.sha);
      await env.DB.prepare("INSERT INTO skills (id, account_id, project_id, source_repo_id, path, commit_sha, active) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO UPDATE SET commit_sha = excluded.commit_sha, active = 1")
        .bind(crypto.randomUUID(), accountId, scopedProject, repository.id, body.path, branch.commit.sha).run();
    } else throw new GitHubError(400, "Invalid skill action");
    const response = NextResponse.json({ ok: true });
    if (auth.refreshed) await setSession(response, request, auth.session);
    return response;
  } catch (error) { return fail(error); }
}
