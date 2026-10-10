import { GitHubError } from "./fava-github.ts";
import type { env } from "./runtime-env.ts";

type Db = typeof env.DB;
const lifetime = 30 * 24 * 60 * 60 * 1000;

function credential() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `fava_dev_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export async function deviceTokenHash(token: string) {
  if (!/^fava_dev_[A-Za-z0-9_-]{43}$/.test(token)) throw new GitHubError(401, "Invalid device credential");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`fava:device:${token}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function listDevices(db: Db, projectId: string) {
  const result = await db.prepare("SELECT id, label, created_at AS createdAt, expires_at AS expiresAt, rotated_at AS rotatedAt, revoked_at AS revokedAt FROM local_devices WHERE project_id = ? ORDER BY created_at DESC")
    .bind(projectId).all<{ id: string; label: string; createdAt: number; expiresAt: number;
      rotatedAt: number | null; revokedAt: number | null }>();
  return result.results;
}

export async function requireLocalRunReady(db: Db, projectId: string) {
  const active = await db.prepare("SELECT 1 FROM eligible_local_devices WHERE project_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1")
    .bind(projectId, Date.now()).first();
  if (!active) throw new GitHubError(409, "Pair a local device for this project before publishing a local run spec");
  const unsupported = await db.prepare("SELECT 1 FROM mcp_grants WHERE project_id = ? AND revoked_at IS NULL LIMIT 1")
    .bind(projectId).first();
  if (unsupported)
    throw new GitHubError(409, "Local runs cannot use MCP grants yet; remove them or choose Fava cloud");
}

export async function pairDevice(db: Db, projectId: string, actorId: number, label: string) {
  const name = label.trim();
  if (name.length < 2 || name.length > 80 || /[\x00-\x1f\x7f]/.test(name))
    throw new GitHubError(400, "Use a 2–80 character device name");
  const now = Date.now();
  const id = crypto.randomUUID();
  const token = credential();
  const results = await db.batch([
    db.prepare("INSERT INTO local_devices (id, project_id, label, token_hash, created_by, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM local_devices WHERE project_id = ? AND revoked_at IS NULL AND expires_at > ?) < 10")
      .bind(id, projectId, name, await deviceTokenHash(token), actorId, now, now + lifetime, projectId, now),
    db.prepare("INSERT INTO local_device_events (id, device_id, project_id, actor_github_id, action, created_at) SELECT ?, id, project_id, ?, 'paired', ? FROM local_devices WHERE id = ?")
      .bind(crypto.randomUUID(), actorId, now, id),
  ]);
  if (results[0].meta.changes !== 1) throw new GitHubError(409, "This project already has ten active devices");
  return { id, label: name, token, expiresAt: now + lifetime };
}

export async function changeDevice(db: Db, projectId: string, actorId: number, id: string,
  action: "rotate" | "revoke") {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new GitHubError(400, "Choose a valid device");
  const now = Date.now();
  const token = action === "rotate" ? credential() : null;
  const event = db.prepare("INSERT INTO local_device_events (id, device_id, project_id, actor_github_id, action, created_at) SELECT ?, id, project_id, ?, ?, ? FROM local_devices WHERE id = ? AND project_id = ? AND revoked_at IS NULL")
    .bind(crypto.randomUUID(), actorId, action === "rotate" ? "rotated" : "revoked", now, id, projectId);
  const update = action === "rotate"
    ? db.prepare("UPDATE local_devices SET token_hash = ?, expires_at = ?, rotated_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL")
      .bind(await deviceTokenHash(token!), now + lifetime, now, id, projectId)
    : db.prepare("UPDATE local_devices SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL")
      .bind(now, id, projectId);
  const results = await db.batch([event, update]);
  if (results[1].meta.changes !== 1) throw new GitHubError(404, "Active device not found in this project");
  return action === "rotate" ? { id, token, expiresAt: now + lifetime } : { id, revokedAt: now };
}
