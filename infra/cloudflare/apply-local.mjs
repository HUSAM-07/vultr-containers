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
