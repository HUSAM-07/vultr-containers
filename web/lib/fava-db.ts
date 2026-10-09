import { github, GitHubError, parseRepo, type Repository } from "./fava-github.ts";
import type { env } from "./runtime-env.ts";

type User = { id: number; login: string; avatarUrl: string };
type Db = typeof env.DB;
type PublishedSpec = { number: number; path: string; branch: string };
type Model = { provider: "openai" | "anthropic"; model: string };
export type Role = "owner" | "admin" | "editor" | "viewer";
type ProjectAccess = { id: string; accountId: string; githubRepoId: number; repository: string;
  defaultBranch: string; accountRole: Role | null; projectRole: Role | null; role: Role };
const rank: Record<Role, number> = { owner: 3, admin: 3, editor: 2, viewer: 1 };

export async function ensurePersonalAccount(db: Db, user: User) {
  const accountId = `github:${user.id}`;
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url")
      .bind(user.id, user.login, user.avatarUrl, now),
    db.prepare("INSERT OR IGNORE INTO accounts (id, name, owner_github_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(accountId, `${user.login}'s workspace`, user.id, now),
    db.prepare("INSERT OR IGNORE INTO account_memberships (account_id, github_id, role) VALUES (?, ?, 'owner')")
      .bind(accountId, user.id),
  ]);
  return accountId;
}

export async function linkProject(db: Db, accountId: string, repo: Repository) {
  const existing = await db.prepare("SELECT account_id AS accountId FROM projects WHERE github_repo_id = ?")
    .bind(repo.id).first<{ accountId: string }>();
  if (existing && existing.accountId !== accountId)
    throw new GitHubError(409, "This repository already belongs to another Fava workspace; ask its administrator to add you");
  try {
    await db.prepare("INSERT INTO projects (id, account_id, github_repo_id, full_name, installation_id, default_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, github_repo_id) DO UPDATE SET full_name = excluded.full_name, installation_id = excluded.installation_id, default_branch = excluded.default_branch")
      .bind(crypto.randomUUID(), accountId, repo.id, repo.fullName, repo.installationId, repo.defaultBranch, Date.now()).run();
  } catch (error) {
    const current = await db.prepare("SELECT account_id AS accountId FROM projects WHERE github_repo_id = ?")
      .bind(repo.id).first<{ accountId: string }>();
    if (current && current.accountId !== accountId)
      throw new GitHubError(409, "This repository already belongs to another Fava workspace; ask its administrator to add you");
    throw error;
  }
  const project = await db.prepare("SELECT id FROM projects WHERE account_id = ? AND github_repo_id = ?")
    .bind(accountId, repo.id).first<{ id: string }>();
  if (!project) throw Error("Project was not saved");
  return { id: project.id, repository: repo.fullName, defaultBranch: repo.defaultBranch,
    role: "owner" as const, accountRole: "owner" as const };
}

async function memberships(db: Db, userId: number) {
  const result = await db.prepare("SELECT projects.id, projects.account_id AS accountId, projects.github_repo_id AS githubRepoId, projects.full_name AS repository, projects.default_branch AS defaultBranch, account_memberships.role AS accountRole, project_memberships.role AS projectRole FROM projects LEFT JOIN account_memberships ON account_memberships.account_id = projects.account_id AND account_memberships.github_id = ? LEFT JOIN project_memberships ON project_memberships.project_id = projects.id AND project_memberships.github_id = ? WHERE account_memberships.github_id IS NOT NULL OR project_memberships.github_id IS NOT NULL ORDER BY projects.created_at DESC")
    .bind(userId, userId).all<Omit<ProjectAccess, "role">>();
  return (result.results as Omit<ProjectAccess, "role">[]).map(project => ({ ...project,
    role: (project.accountRole && (!project.projectRole || rank[project.accountRole] >= rank[project.projectRole])
      ? project.accountRole : project.projectRole!) as Role }));
}

export async function listProjects(db: Db, userId: number, repositories: Repository[]) {
  const available = new Set(repositories.map(repo => repo.id));
  const selected = new Map<string, ProjectAccess>();
  for (const project of await memberships(db, userId)) {
    if (!available.has(project.githubRepoId)) continue;
    const prior = selected.get(project.repository);
    if (!prior || rank[project.role] > rank[prior.role] ||
      (rank[project.role] === rank[prior.role] && project.accountId === `github:${userId}`))
      selected.set(project.repository, project);
  }
  return [...selected.values()].map(({ id, repository, defaultBranch, role, accountRole }) =>
    ({ id, repository, defaultBranch, role, accountRole }));
}

export async function projectAccess(db: Db, userId: number, repository: string, token: string,
  minimum: "viewer" | "editor" | "admin" = "viewer", projectId?: string) {
  const name = parseRepo(repository);
  const projects = (await memberships(db, userId)).filter(project =>
    project.repository.toLowerCase() === name.toLowerCase() && rank[project.role] >= rank[minimum] &&
    (!projectId || project.id === projectId));
  const project = projects.sort((a, b) => rank[b.role] - rank[a.role] ||
    Number(b.accountId === `github:${userId}`) - Number(a.accountId === `github:${userId}`))[0];
  if (!project) throw new GitHubError(403, "You do not have access to this Fava project");
  const current = await github<{ id: number }>(token, `/repos/${name}`);
  if (current.id !== project.githubRepoId) throw new GitHubError(403, "Repository identity changed; relink it to Fava");
  return project;
}

export async function listProjectMembers(db: Db, projectId: string) {
  const result = await db.prepare("SELECT users.github_id AS githubId, users.login, project_memberships.role FROM project_memberships JOIN users ON users.github_id = project_memberships.github_id WHERE project_memberships.project_id = ? ORDER BY users.login COLLATE NOCASE")
    .bind(projectId).all<{ githubId: number; login: string; role: "admin" | "editor" | "viewer" }>();
  return result.results;
}

export async function setProjectMember(db: Db, projectId: string, login: string,
  role: "admin" | "editor" | "viewer") {
  const user = await db.prepare("SELECT github_id AS githubId FROM users WHERE login = ? COLLATE NOCASE")
    .bind(login).first<{ githubId: number }>();
  if (!user) throw new GitHubError(404, "This GitHub user must sign in to Fava before joining a project");
  await db.prepare("INSERT INTO project_memberships (project_id, github_id, role) VALUES (?, ?, ?) ON CONFLICT(project_id, github_id) DO UPDATE SET role = excluded.role")
    .bind(projectId, user.githubId, role).run();
  return user.githubId;
}

export async function removeProjectMember(db: Db, projectId: string, githubId: number) {
  await db.prepare("DELETE FROM project_memberships WHERE project_id = ? AND github_id = ?")
    .bind(projectId, githubId).run();
}

export async function listRuns(db: Db, accountId: string, repository: string) {
  const result = await db.prepare("SELECT runs.id, runs.status, runs.model, runs.provider, runs.summary, runs.error, runs.artifact_key AS artifactKey, runs.merged_commit_sha AS mergedCommitSha, runs.created_at AS createdAt, runs.pull_number AS pullNumber, runs.preview_url AS previewUrl, specs.pull_number AS specPullNumber, specs.path AS specPath FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE projects.account_id = ? AND projects.full_name = ? ORDER BY runs.created_at DESC LIMIT 20")
    .bind(accountId, repository).all<{ id: string; status: string; model: string; provider: string;
      summary: string | null; error: string | null; artifactKey: string | null;
      mergedCommitSha: string; createdAt: number; pullNumber: number | null; previewUrl: string | null;
      specPullNumber: number; specPath: string }>();
  return result.results;
}

export async function recordSpec(db: Db, projectId: string, userId: number, spec: PublishedSpec, selected: Model) {
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO specs (id, project_id, path, branch, pull_number, status, created_by, created_at, provider, model) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)")
    .bind(id, projectId, spec.path, spec.branch, spec.number, userId, Date.now(), selected.provider, selected.model).run();
  return id;
}
