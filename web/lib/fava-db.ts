import { github, GitHubError, parseRepo, type Repository } from "./fava-github.ts";
import { appJwt } from "./fava-webhook.ts";
import type { env } from "./runtime-env.ts";

type User = { id: number; login: string; avatarUrl: string };
type Db = typeof env.DB;
type PublishedSpec = { number: number; path: string; branch: string };
type Model = { provider: "openai" | "anthropic"; model: string };
export type Role = "owner" | "admin" | "editor" | "viewer";
type ProjectAccess = { id: string; accountId: string; githubRepoId: number; installationId: number; repository: string;
  accountName: string; defaultBranch: string; accountRole: Role | null; projectRole: Role | null; role: Role };
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

export async function listAccounts(db: Db, userId: number) {
  const result = await db.prepare("SELECT accounts.id, accounts.name, account_memberships.role FROM accounts JOIN account_memberships ON account_memberships.account_id = accounts.id WHERE account_memberships.github_id = ? ORDER BY accounts.created_at, accounts.id")
    .bind(userId).all<{ id: string; name: string; role: Role }>();
  return result.results;
}

export async function accountAccess(db: Db, userId: number, accountId: string,
  minimum: "viewer" | "editor" | "admin" = "viewer") {
  const account = await db.prepare("SELECT accounts.id, accounts.name, accounts.owner_github_id AS ownerGithubId, account_memberships.role FROM accounts JOIN account_memberships ON account_memberships.account_id = accounts.id WHERE accounts.id = ? AND account_memberships.github_id = ?")
    .bind(accountId, userId).first<{ id: string; name: string; ownerGithubId: number; role: Role }>() as
      { id: string; name: string; ownerGithubId: number; role: Role } | null;
  if (!account || rank[account.role] < rank[minimum])
    throw new GitHubError(403, "You do not have access to manage this workspace");
  return account;
}

export async function createAccount(db: Db, userId: number, name: string) {
  const id = `team:${crypto.randomUUID()}`;
  await db.batch([
    db.prepare("INSERT INTO accounts (id, name, owner_github_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, name, userId, Date.now()),
    db.prepare("INSERT INTO account_memberships (account_id, github_id, role) VALUES (?, ?, 'owner')")
      .bind(id, userId),
  ]);
  return { id, name, role: "owner" as const };
}

export async function listAccountMembers(db: Db, accountId: string) {
  const result = await db.prepare("SELECT users.github_id AS githubId, users.login, account_memberships.role, EXISTS(SELECT 1 FROM accounts AS personal WHERE personal.id = 'github:' || users.github_id) AS signedIn FROM account_memberships JOIN users ON users.github_id = account_memberships.github_id WHERE account_memberships.account_id = ? ORDER BY users.login COLLATE NOCASE")
    .bind(accountId).all<{ githubId: number; login: string; role: Role; signedIn: number }>();
  return result.results;
}

async function githubUser(db: Db, token: string, login: string) {
  const identity = await github<{ id: number; login: string }>(token, `/users/${encodeURIComponent(login)}`);
  if (!Number.isSafeInteger(identity.id) || identity.id <= 0 ||
    !/^[A-Za-z0-9-]{1,39}$/.test(identity.login)) throw new GitHubError(502, "GitHub returned an invalid user");
  await db.prepare("INSERT INTO users (github_id, login, created_at) VALUES (?, ?, ?) ON CONFLICT(github_id) DO UPDATE SET login = excluded.login")
    .bind(identity.id, identity.login, Date.now()).run();
  return identity.id;
}

export async function setAccountMember(db: Db, accountId: string, token: string, login: string,
  role: "admin" | "editor" | "viewer") {
  const githubId = await githubUser(db, token, login);
  const account = await db.prepare("SELECT owner_github_id AS ownerGithubId FROM accounts WHERE id = ?")
    .bind(accountId).first<{ ownerGithubId: number }>();
  if (githubId === account?.ownerGithubId) throw new GitHubError(403, "Workspace owner role cannot be changed");
  await db.prepare("INSERT INTO account_memberships (account_id, github_id, role) VALUES (?, ?, ?) ON CONFLICT(account_id, github_id) DO UPDATE SET role = excluded.role")
    .bind(accountId, githubId, role).run();
  return githubId;
}

export async function removeAccountMember(db: Db, accountId: string, githubId: number) {
  const account = await db.prepare("SELECT owner_github_id AS ownerGithubId FROM accounts WHERE id = ?")
    .bind(accountId).first<{ ownerGithubId: number }>();
  if (githubId === account?.ownerGithubId) throw new GitHubError(403, "Workspace owner cannot be removed");
  await db.batch([
    db.prepare("DELETE FROM account_memberships WHERE account_id = ? AND github_id = ?")
      .bind(accountId, githubId),
    db.prepare("DELETE FROM project_memberships WHERE github_id = ? AND project_id IN (SELECT id FROM projects WHERE account_id = ?)")
      .bind(githubId, accountId),
  ]);
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
  return { id: project.id, repository: repo.fullName, defaultBranch: repo.defaultBranch };
}

async function memberships(db: Db, userId: number) {
  const result = await db.prepare("SELECT projects.id, projects.account_id AS accountId, accounts.name AS accountName, projects.github_repo_id AS githubRepoId, projects.installation_id AS installationId, projects.full_name AS repository, projects.default_branch AS defaultBranch, account_memberships.role AS accountRole, project_memberships.role AS projectRole FROM projects JOIN accounts ON accounts.id = projects.account_id LEFT JOIN account_memberships ON account_memberships.account_id = projects.account_id AND account_memberships.github_id = ? LEFT JOIN project_memberships ON project_memberships.project_id = projects.id AND project_memberships.github_id = ? WHERE account_memberships.github_id IS NOT NULL OR project_memberships.github_id IS NOT NULL ORDER BY projects.created_at DESC")
    .bind(userId, userId).all<Omit<ProjectAccess, "role">>();
  return (result.results as Omit<ProjectAccess, "role">[]).map(project => ({ ...project,
    role: (project.accountRole && (!project.projectRole || rank[project.accountRole] >= rank[project.projectRole])
      ? project.accountRole : project.projectRole!) as Role }));
}

export async function listProjects(db: Db, userId: number, repositories: Repository[]) {
  const available = new Map(repositories.map(repo => [repo.id, repo.installationId]));
  const selected = new Map<string, ProjectAccess>();
  for (const project of await memberships(db, userId)) {
    if (available.get(project.githubRepoId) !== project.installationId || project.installationId <= 0) continue;
    const prior = selected.get(project.repository);
    if (!prior || rank[project.role] > rank[prior.role] ||
      (rank[project.role] === rank[prior.role] && project.accountId === `github:${userId}`))
      selected.set(project.repository, project);
  }
  return [...selected.values()].map(({ id, accountId, accountName, repository, defaultBranch, role, accountRole }) =>
    ({ id, accountId, accountName, repository, defaultBranch, role, accountRole }));
}

export async function projectAccess(db: Db, userId: number, repository: string, token: string,
  minimum: "viewer" | "editor" | "admin" = "viewer", projectId?: string) {
  const name = parseRepo(repository);
  const projects = (await memberships(db, userId)).filter(project =>
    project.installationId > 0 && project.repository.toLowerCase() === name.toLowerCase() && rank[project.role] >= rank[minimum] &&
    (!projectId || project.id === projectId));
  const project = projects.sort((a, b) => rank[b.role] - rank[a.role] ||
    Number(b.accountId === `github:${userId}`) - Number(a.accountId === `github:${userId}`))[0];
  if (!project) throw new GitHubError(403, "You do not have access to this Fava project");
  const current = await github<{ id: number }>(token, `/repos/${name}`);
  if (current.id !== project.githubRepoId) throw new GitHubError(403, "Repository identity changed; relink it to Fava");
  if (!process.env.GITHUB_APP_CLIENT_ID || !process.env.GITHUB_APP_PRIVATE_KEY)
    throw new GitHubError(503, "The Fava GitHub App is not configured");
  const installation = await github<{ id: number }>(
    appJwt(process.env.GITHUB_APP_CLIENT_ID, process.env.GITHUB_APP_PRIVATE_KEY),
    `/repos/${name}/installation`);
  if (installation.id !== project.installationId)
    throw new GitHubError(403, "The Fava GitHub App no longer has access to this repository");
  return project;
}

export async function listProjectMembers(db: Db, projectId: string) {
  const result = await db.prepare("SELECT users.github_id AS githubId, users.login, project_memberships.role, EXISTS(SELECT 1 FROM accounts AS personal WHERE personal.id = 'github:' || users.github_id) AS signedIn FROM project_memberships JOIN users ON users.github_id = project_memberships.github_id WHERE project_memberships.project_id = ? ORDER BY users.login COLLATE NOCASE")
    .bind(projectId).all<{ githubId: number; login: string; role: "admin" | "editor" | "viewer"; signedIn: number }>();
  return result.results;
}

export async function setProjectMember(db: Db, projectId: string, token: string, login: string,
  role: "admin" | "editor" | "viewer") {
  const githubId = await githubUser(db, token, login);
  await db.prepare("INSERT INTO project_memberships (project_id, github_id, role) VALUES (?, ?, ?) ON CONFLICT(project_id, github_id) DO UPDATE SET role = excluded.role")
    .bind(projectId, githubId, role).run();
  return githubId;
}

export async function removeProjectMember(db: Db, projectId: string, githubId: number) {
  await db.prepare("DELETE FROM project_memberships WHERE project_id = ? AND github_id = ?")
    .bind(projectId, githubId).run();
}

export async function listRuns(db: Db, accountId: string, repository: string) {
  const result = await db.prepare("SELECT runs.id, runs.status, runs.model, runs.provider, runs.execution_mode AS executionMode, runs.summary, runs.error, runs.artifact_key AS artifactKey, runs.merged_commit_sha AS mergedCommitSha, runs.created_at AS createdAt, runs.completed_at AS completedAt, runs.publishing_at AS publishingAt, runs.implementation_sha AS implementationSha, runs.pull_number AS pullNumber, runs.preview_url AS previewUrl, specs.pull_number AS specPullNumber, specs.path AS specPath FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE projects.account_id = ? AND projects.full_name = ? ORDER BY runs.created_at DESC LIMIT 20")
    .bind(accountId, repository).all<{ id: string; status: string; model: string; provider: string; executionMode: "cloud" | "local";
      summary: string | null; error: string | null; artifactKey: string | null;
      mergedCommitSha: string; createdAt: number; completedAt: number | null; publishingAt: number | null; implementationSha: string | null;
      pullNumber: number | null; previewUrl: string | null;
      specPullNumber: number; specPath: string }>();
  return result.results;
}

export async function cancelRun(db: Db, projectId: string, runId: string) {
  const reason = "Cancellation requested by project member";
  const changed = await db.prepare("UPDATE runs SET status = 'cancelled', error = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'running') AND publishing_at IS NULL AND spec_id IN (SELECT id FROM specs WHERE project_id = ?)")
    .bind(reason, Date.now(), runId, projectId).run();
  if (changed.meta.changes === 1) return reason;
  const run = await db.prepare("SELECT runs.status, runs.error FROM runs JOIN specs ON specs.id = runs.spec_id WHERE runs.id = ? AND specs.project_id = ?")
    .bind(runId, projectId).first<{ status: string; error: string | null }>();
  if (!run) throw new GitHubError(404, "Run not found");
  if (run.status === "cancelled") return run.error || reason;
  throw new GitHubError(409, "This run has already finished or started publishing its pull request");
}

export async function recordSpec(db: Db, projectId: string, userId: number, spec: PublishedSpec, selected: Model,
  executionMode: "cloud" | "local" = "cloud") {
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO specs (id, project_id, path, branch, pull_number, status, created_by, created_at, provider, model, execution_mode) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)")
    .bind(id, projectId, spec.path, spec.branch, spec.number, userId, Date.now(), selected.provider, selected.model, executionMode).run();
  return id;
}
