import type { Repository } from "./fava-github.ts";
import type { env } from "./runtime-env.ts";

type User = { id: number; login: string; avatarUrl: string };
type Db = typeof env.DB;
type PublishedSpec = { number: number; path: string; branch: string };

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
  await db.prepare("INSERT INTO projects (id, account_id, github_repo_id, full_name, installation_id, default_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, github_repo_id) DO UPDATE SET full_name = excluded.full_name, installation_id = excluded.installation_id, default_branch = excluded.default_branch")
    .bind(crypto.randomUUID(), accountId, repo.id, repo.fullName, repo.installationId, repo.defaultBranch, Date.now()).run();
  const project = await db.prepare("SELECT id FROM projects WHERE account_id = ? AND github_repo_id = ?")
    .bind(accountId, repo.id).first<{ id: string }>();
  if (!project) throw Error("Project was not saved");
  return { id: project.id, repository: repo.fullName };
}

export async function listProjects(db: Db, accountId: string) {
  const result = await db.prepare("SELECT id, full_name AS repository, default_branch AS defaultBranch FROM projects WHERE account_id = ? ORDER BY created_at DESC")
    .bind(accountId).all<{ id: string; repository: string; defaultBranch: string }>();
  return result.results;
}

export async function recordSpec(db: Db, projectId: string, userId: number, spec: PublishedSpec) {
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO specs (id, project_id, path, branch, pull_number, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)")
    .bind(id, projectId, spec.path, spec.branch, spec.number, userId, Date.now()).run();
  return id;
}
