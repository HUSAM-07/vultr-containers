import { GitHubError } from "./fava-github.ts";
import { deviceTokenHash } from "./fava-devices.ts";
import type { env } from "./runtime-env.ts";

type Db = typeof env.DB;
const leaseMs = 90_000;
type Device = { id: string; projectId: string };
type Candidate = { id: string; repository: string; sha: string; specPath: string;
  provider: string; model: string };

export async function authenticateDevice(db: Db, authorization: string | null): Promise<Device> {
  if (!authorization?.startsWith("Bearer ")) throw new GitHubError(401, "Device credential required");
  const hash = await deviceTokenHash(authorization.slice(7));
  const device = await db.prepare("SELECT id, project_id AS projectId FROM eligible_local_devices WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(hash, Date.now()).first<Device>();
  if (!device) throw new GitHubError(401, "Device credential is no longer active");
  return device;
}

export async function claimLocalRun(db: Db, device: Device) {
  const now = Date.now();
  const busy = await db.prepare("SELECT 1 FROM runs WHERE lease_device_id = ? AND execution_mode = 'local' AND status = 'running' AND lease_expires_at > ? LIMIT 1")
    .bind(device.id, now).first();
  if (busy) return null;
  const candidates = await db.prepare("SELECT runs.id, runs.merged_commit_sha AS sha, runs.provider, runs.model, specs.path AS specPath, projects.full_name AS repository FROM runs JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id WHERE specs.project_id = ? AND runs.execution_mode = 'local' AND ((runs.status = 'queued') OR (runs.status = 'running' AND runs.lease_expires_at < ?)) AND specs.status = 'merged' AND specs.merged_commit_sha = runs.merged_commit_sha AND specs.execution_mode = runs.execution_mode AND specs.provider = runs.provider AND specs.model = runs.model AND projects.installation_id > 0 ORDER BY runs.created_at LIMIT 5")
    .bind(device.projectId, now).all<Candidate>();
  for (const run of candidates.results) {
    const leaseId = crypto.randomUUID();
    const expiresAt = now + leaseMs;
    const claimed = await db.prepare("UPDATE runs SET status = 'running', lease_id = ?, lease_device_id = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND execution_mode = 'local' AND ((status = 'queued') OR (status = 'running' AND lease_expires_at < ?)) AND publishing_at IS NULL AND EXISTS (SELECT 1 FROM specs JOIN projects ON projects.id = specs.project_id WHERE specs.id = runs.spec_id AND specs.project_id = ? AND specs.status = 'merged' AND specs.merged_commit_sha = runs.merged_commit_sha AND specs.execution_mode = runs.execution_mode AND specs.provider = runs.provider AND specs.model = runs.model AND projects.installation_id > 0) AND EXISTS (SELECT 1 FROM eligible_local_devices WHERE id = ? AND project_id = ? AND revoked_at IS NULL AND expires_at > ?) AND NOT EXISTS (SELECT 1 FROM runs AS other WHERE other.id <> runs.id AND other.lease_device_id = ? AND other.execution_mode = 'local' AND other.status = 'running' AND other.lease_expires_at > ?)")
      .bind(leaseId, device.id, expiresAt, now, run.id, now, device.projectId, device.id, device.projectId, now, device.id, now).run();
    if (claimed.meta.changes === 1) return { ...run, leaseId, expiresAt };
  }
  return null;
}

export async function renewLocalRun(db: Db, device: Device, runId: string, leaseId: string) {
  if (!/^[a-f0-9-]{36}$/i.test(runId) || !/^[a-f0-9-]{36}$/i.test(leaseId))
    throw new GitHubError(400, "Invalid run lease");
  const now = Date.now();
  const expiresAt = now + leaseMs;
  const result = await db.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ? AND lease_id = ? AND lease_device_id = ? AND execution_mode = 'local' AND status = 'running' AND lease_expires_at > ? AND publishing_at IS NULL AND EXISTS (SELECT 1 FROM specs JOIN projects ON projects.id = specs.project_id WHERE specs.id = runs.spec_id AND specs.project_id = ? AND specs.status = 'merged' AND specs.merged_commit_sha = runs.merged_commit_sha AND specs.execution_mode = runs.execution_mode AND specs.provider = runs.provider AND specs.model = runs.model AND projects.installation_id > 0) AND EXISTS (SELECT 1 FROM eligible_local_devices WHERE id = ? AND project_id = ? AND revoked_at IS NULL AND expires_at > ?)")
    .bind(expiresAt, runId, leaseId, device.id, now, device.projectId, device.id, device.projectId, now).run();
  if (result.meta.changes !== 1) throw new GitHubError(409, "Run lease is no longer active");
  return { runId, leaseId, expiresAt };
}
