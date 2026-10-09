import { readFile } from "node:fs/promises";

const origin = new URL(process.argv[2] || "http://127.0.0.1:3001");
if (!["localhost", "127.0.0.1"].includes(origin.hostname))
  throw Error("Local D1 migration only accepts a loopback preview URL");

const explorer = new URL("/cdn-cgi/local/explorer/api/d1/database", origin);
const databases = await (await fetch(explorer)).json();
const database = databases.result?.find(item => item.name === "DB");
if (!database) throw Error("Start the Cloudflare Worker preview with its DB binding first");
const endpoint = new URL(`${explorer.pathname}/${encodeURIComponent(database.uuid)}/raw`, origin);

async function query(sql) {
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }) });
  const result = await response.json();
  if (!response.ok || !result.success || !result.result?.[0]?.success)
    throw Error(`Local D1 query failed: ${JSON.stringify(result.errors || result.result?.[0]?.error || [])}`);
  return result.result[0].results;
}

const expected = ["users", "accounts", "account_memberships", "sessions", "projects", "project_memberships",
  "specs", "runs", "skills", "mcp_grants", "deployments", "webhook_deliveries"];
const current = (await query("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map(row => row[0]);
if (expected.every(name => current.includes(name))) {
  console.log("Local Fava D1 schema is already applied");
} else if (expected.some(name => current.includes(name))) {
  throw Error("Local D1 has a partial Fava schema; inspect it before applying migrations");
} else {
  await query(await readFile(new URL("./0001_core.sql", import.meta.url), "utf8"));
  const installed = (await query("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map(row => row[0]);
  if (!expected.every(name => installed.includes(name))) throw Error("Local D1 schema verification failed");
  console.log("Local Fava D1 schema applied");
}

const specColumns = (await query("PRAGMA table_info(specs)")).rows.map(row => row[1]);
const modelColumns = ["provider", "model"];
if (modelColumns.every(name => specColumns.includes(name))) {
  console.log("Local Fava model migration is already applied");
} else if (modelColumns.some(name => specColumns.includes(name))) {
  throw Error("Local D1 has a partial model migration; inspect it before applying migrations");
} else {
  await query(await readFile(new URL("./0002_spec_model.sql", import.meta.url), "utf8"));
  const installed = (await query("PRAGMA table_info(specs)")).rows.map(row => row[1]);
  if (!modelColumns.every(name => installed.includes(name))) throw Error("Local model migration verification failed");
  console.log("Local Fava model migration applied");
}

const runColumns = (await query("PRAGMA table_info(runs)")).rows.map(row => row[1]);
const outputColumns = ["summary", "error", "artifact_key"];
if (outputColumns.every(name => runColumns.includes(name))) {
  console.log("Local Fava run-output migration is already applied");
} else if (outputColumns.some(name => runColumns.includes(name))) {
  throw Error("Local D1 has a partial run-output migration; inspect it before applying migrations");
} else {
  await query(await readFile(new URL("./0003_run_output.sql", import.meta.url), "utf8"));
  const installed = (await query("PRAGMA table_info(runs)")).rows.map(row => row[1]);
  if (!outputColumns.every(name => installed.includes(name))) throw Error("Local run-output migration verification failed");
  console.log("Local Fava run-output migration applied");
}

const startColumns = (await query("PRAGMA table_info(runs)")).rows.map(row => row[1]);
if (startColumns.includes("started_at")) {
  console.log("Local Fava run-start migration is already applied");
} else {
  await query(await readFile(new URL("./0004_run_started_at.sql", import.meta.url), "utf8"));
  const installed = (await query("PRAGMA table_info(runs)")).rows.map(row => row[1]);
  if (!installed.includes("started_at")) throw Error("Local run-start migration verification failed");
  console.log("Local Fava run-start migration applied");
}

const previewTables = ["cloudflare_connections", "cloudflare_project_previews"];
const currentPreviewTables = (await query("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map(row => row[0]);
if (previewTables.every(name => currentPreviewTables.includes(name))) {
  console.log("Local Cloudflare Preview migration is already applied");
} else if (previewTables.some(name => currentPreviewTables.includes(name))) {
  throw Error("Local D1 has a partial Cloudflare Preview migration; inspect it before applying migrations");
} else {
  await query(await readFile(new URL("./0005_worker_previews.sql", import.meta.url), "utf8"));
  const installed = (await query("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map(row => row[0]);
  if (!previewTables.every(name => installed.includes(name))) throw Error("Local Cloudflare Preview migration verification failed");
  console.log("Local Cloudflare Preview migration applied");
}

const runSkillTable = (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_skills'")).rows.length > 0;
if (runSkillTable) {
  console.log("Local run-skills migration is already applied");
} else {
  await query(await readFile(new URL("./0006_run_skills.sql", import.meta.url), "utf8"));
  const installed = (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_skills'")).rows.length > 0;
  if (!installed) throw Error("Local run-skills migration verification failed");
  console.log("Local run-skills migration applied");
}

const uniqueRepo = (await query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_github_repo_unique'")).rows.length > 0;
if (uniqueRepo) {
  console.log("Local project identity migration is already applied");
} else {
  await query(await readFile(new URL("./0007_unique_project_repository.sql", import.meta.url), "utf8"));
  const installed = (await query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_github_repo_unique'")).rows.length > 0;
  if (!installed) throw Error("Local project identity migration verification failed");
  console.log("Local project identity migration applied");
}

const runMcpGrants = (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_mcp_grants'")).rows.length > 0;
if (runMcpGrants) {
  console.log("Local run-MCP-grants migration is already applied");
} else {
  await query(await readFile(new URL("./0008_run_mcp_grants.sql", import.meta.url), "utf8"));
  const installed = (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_mcp_grants'")).rows.length > 0;
  if (!installed) throw Error("Local run-MCP-grants migration verification failed");
  console.log("Local run-MCP-grants migration applied");
}

const implementationColumns = (await query("PRAGMA table_info(runs)")).rows.map(row => row[1]);
if (implementationColumns.includes("implementation_sha")) {
  console.log("Local implementation-commit migration is already applied");
} else {
  await query(await readFile(new URL("./0009_implementation_sha.sql", import.meta.url), "utf8"));
  const installed = (await query("PRAGMA table_info(runs)")).rows.map(row => row[1]);
  if (!installed.includes("implementation_sha")) throw Error("Local implementation-commit migration verification failed");
  console.log("Local implementation-commit migration applied");
}

const publicationColumns = (await query("PRAGMA table_info(runs)")).rows.map(row => row[1]);
if (publicationColumns.includes("publishing_at")) {
  console.log("Local run-publication migration is already applied");
} else {
  await query(await readFile(new URL("./0010_run_publication_fence.sql", import.meta.url), "utf8"));
  const installed = (await query("PRAGMA table_info(runs)")).rows.map(row => row[1]);
  if (!installed.includes("publishing_at")) throw Error("Local run-publication migration verification failed");
  console.log("Local run-publication migration applied");
}

const sessionColumns = (await query("PRAGMA table_info(sessions)")).rows.map(row => row[1]);
if (sessionColumns.includes("payload_ciphertext")) {
  console.log("Local server-session migration is already applied");
} else {
  await query(await readFile(new URL("./0011_server_sessions.sql", import.meta.url), "utf8"));
  const installed = (await query("PRAGMA table_info(sessions)")).rows.map(row => row[1]);
  if (!installed.includes("payload_ciphertext")) throw Error("Local server-session migration verification failed");
  console.log("Local server-session migration applied");
}

const cloudflareColumns = (await query("PRAGMA table_info(cloudflare_connections)")).rows.map(row => row[1]);
const oauthColumns = ["auth_method", "refresh_ciphertext", "token_expires_at"];
if (oauthColumns.every(name => cloudflareColumns.includes(name))) {
  console.log("Local Cloudflare OAuth migration is already applied");
} else if (oauthColumns.some(name => cloudflareColumns.includes(name))) {
  throw Error("Local D1 has a partial Cloudflare OAuth migration; inspect it before applying migrations");
} else {
  await query(await readFile(new URL("./0012_cloudflare_oauth.sql", import.meta.url), "utf8"));
  const installed = (await query("PRAGMA table_info(cloudflare_connections)")).rows.map(row => row[1]);
  if (!oauthColumns.every(name => installed.includes(name))) throw Error("Local Cloudflare OAuth migration verification failed");
  console.log("Local Cloudflare OAuth migration applied");
}

const localDevices = (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('local_devices', 'local_device_events')")).rows.map(row => row[0]);
if (localDevices.length === 2) {
  console.log("Local device migration is already applied");
} else if (localDevices.length) {
  throw Error("Local D1 has a partial device migration; inspect it before applying migrations");
} else {
  await query(await readFile(new URL("./0013_local_devices.sql", import.meta.url), "utf8"));
  const installed = (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('local_devices', 'local_device_events')")).rows;
  if (installed.length !== 2) throw Error("Local device migration verification failed");
  console.log("Local device migration applied");
}

const leaseColumns = (await query("PRAGMA table_info(runs)")).rows.map(row => row[1]);
const localLeaseColumns = ["execution_mode", "lease_id", "lease_device_id", "lease_expires_at"];
const specMode = (await query("PRAGMA table_info(specs)")).rows.some(row => row[1] === "execution_mode");
const eligibleView = (await query("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'eligible_local_devices'")).rows.length === 1;
if (localLeaseColumns.every(name => leaseColumns.includes(name)) && specMode && eligibleView) {
  console.log("Local run-lease migration is already applied");
} else if (localLeaseColumns.some(name => leaseColumns.includes(name)) || specMode || eligibleView) {
  throw Error("Local D1 has a partial run-lease migration; inspect it before applying migrations");
} else {
  await query(await readFile(new URL("./0014_local_run_leases.sql", import.meta.url), "utf8"));
  const installed = (await query("PRAGMA table_info(runs)")).rows.map(row => row[1]);
  const view = (await query("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'eligible_local_devices'")).rows.length === 1;
  if (!localLeaseColumns.every(name => installed.includes(name)) || !view) throw Error("Local run-lease migration verification failed");
  console.log("Local run-lease migration applied");
}
