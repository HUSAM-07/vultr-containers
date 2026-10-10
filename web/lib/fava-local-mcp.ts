import { createHmac, timingSafeEqual } from "node:crypto";
import { GitHubError } from "./fava-github.ts";
import { renewLocalRun } from "./fava-local-runs.ts";
import { mcpTools, type McpGrant } from "./fava-mcp.ts";
import type { env } from "./runtime-env.ts";

type Db = typeof env.DB;
type Device = { id: string; projectId: string };
const idPattern = /^[a-f0-9-]{36}$/i;

export function localMcpCapability(runId: string, leaseId: string, grantId: string, secret: string) {
  if (![runId, leaseId, grantId].every(id => idPattern.test(id)) || secret.length < 32)
    throw Error("Invalid local MCP capability configuration");
  const signature = createHmac("sha256", secret).update(`fava:local-mcp:${runId}:${leaseId}:${grantId}`).digest("hex");
  return `${leaseId}.${signature}`;
}

export function readLocalMcpCapability(value: string | null, runId: string, grantId: string, secret: string) {
  if (!value || !idPattern.test(runId) || !idPattern.test(grantId) || secret.length < 32) return null;
  const match = /^([a-f0-9-]{36})\.([a-f0-9]{64})$/i.exec(value);
  if (!match) return null;
  const expected = localMcpCapability(runId, match[1], grantId, secret).split(".")[1];
  return timingSafeEqual(Buffer.from(match[2], "hex"), Buffer.from(expected, "hex")) ? match[1] : null;
}

export async function localMcpGrants(db: Db, device: Device, runId: string, leaseId: string, secret: string) {
  await renewLocalRun(db, device, runId, leaseId);
  const found = await db.prepare("SELECT run_mcp_grants.grant_id AS id, mcp_grants.allowed_tools_json AS toolsJson FROM run_mcp_grants JOIN mcp_grants ON mcp_grants.id = run_mcp_grants.grant_id WHERE run_mcp_grants.run_id = ? AND mcp_grants.project_id = ? AND mcp_grants.revoked_at IS NULL ORDER BY run_mcp_grants.grant_id LIMIT 9")
    .bind(runId, device.projectId).all<{ id: string; toolsJson: string }>();
  if (found.results.length > 8) throw new GitHubError(409, "Run has more than eight MCP grants");
  await renewLocalRun(db, device, runId, leaseId);
  return { grants: found.results.map((grant: { id: string; toolsJson: string }) => ({ id: grant.id,
    token: localMcpCapability(runId, leaseId, grant.id, secret),
    allowedTools: mcpTools(JSON.parse(grant.toolsJson)) })) };
}

export async function authorizedLocalMcpGrant(db: Db, runId: string, grantId: string,
  authorization: string | null, secret: string) {
  const leaseId = readLocalMcpCapability(authorization?.replace(/^Bearer /i, "") || null,
    runId, grantId, secret);
  if (!leaseId) throw new GitHubError(403, "Local MCP capability is invalid");
  const now = Date.now();
  const grant = await db.prepare("SELECT mcp_grants.server_url AS serverUrl, mcp_grants.allowed_tools_json AS toolsJson, mcp_grants.credential_ref AS credentialRef FROM run_mcp_grants JOIN mcp_grants ON mcp_grants.id = run_mcp_grants.grant_id JOIN runs ON runs.id = run_mcp_grants.run_id JOIN specs ON specs.id = runs.spec_id JOIN projects ON projects.id = specs.project_id JOIN eligible_local_devices AS devices ON devices.id = runs.lease_device_id WHERE runs.id = ? AND run_mcp_grants.grant_id = ? AND runs.lease_id = ? AND runs.execution_mode = 'local' AND runs.status = 'running' AND runs.lease_expires_at > ? AND runs.local_submitted_at IS NULL AND runs.publishing_at IS NULL AND specs.status = 'merged' AND specs.merged_commit_sha = runs.merged_commit_sha AND specs.execution_mode = runs.execution_mode AND specs.provider = runs.provider AND specs.model = runs.model AND mcp_grants.project_id = projects.id AND mcp_grants.revoked_at IS NULL AND projects.installation_id > 0 AND devices.project_id = projects.id AND devices.revoked_at IS NULL AND devices.expires_at > ?")
    .bind(runId, grantId, leaseId, now, now).first<McpGrant>();
  if (!grant) throw new GitHubError(403, "Local MCP grant or lease is no longer active");
  return grant;
}
