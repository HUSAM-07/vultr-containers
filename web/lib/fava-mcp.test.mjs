import test from "node:test";
import assert from "node:assert/strict";
import { allowedMcpRequest, forwardMcp, mcpForwardHeaders, mcpServerUrl, mcpTools } from "./fava-mcp.ts";
import { encryptToken } from "./fava-cloudflare.ts";

test("MCP grants accept only public HTTPS endpoints and named tools", () => {
  assert.equal(mcpServerUrl("https://mcp.example.org/tools"), "https://mcp.example.org/tools");
  for (const url of ["http://mcp.example.org", "https://localhost/mcp", "https://127.0.0.1/mcp",
    "https://[::1]/mcp", "https://user:pass@mcp.example.org/mcp", "https://mcp.example.org/mcp?token=secret",
    "https://mcp.example.org:8443/mcp"]) assert.throws(() => mcpServerUrl(url));
  assert.deepEqual(mcpTools(["aws.list_buckets", "gcp/projects.list"]),
    ["aws.list_buckets", "gcp/projects.list"]);
  assert.throws(() => mcpTools(["aws.list_buckets", "aws.list_buckets"]));
  assert.throws(() => mcpTools(["tools/call?unsafe"]));
});

test("MCP proxy grants only selected tool calls", () => {
  const tools = ["aws.list_buckets"];
  assert.equal(allowedMcpRequest({ method: "initialize" }, tools), true);
  assert.equal(allowedMcpRequest({ method: "server/discover" }, tools), true);
  assert.equal(allowedMcpRequest({ method: "tools/list" }, tools), true);
  assert.equal(allowedMcpRequest({ method: "tools/call", params: { name: "aws.list_buckets" } }, tools), true);
  assert.equal(allowedMcpRequest({ method: "tools/call", params: { name: "aws.delete_bucket" } }, tools), false);
  assert.equal(allowedMcpRequest({ method: "resources/read" }, tools), false);
  assert.equal(allowedMcpRequest([{ method: "tools/call", params: { name: "aws.list_buckets" } }], tools), false);
});

test("MCP proxy mirrors modern routing headers from the approved RPC", () => {
  const inbound = new Headers({ "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list",
    "Mcp-Name": "unapproved", "Mcp-Param-Region": "us-east-1", Authorization: "Bearer agent-capability" });
  const forwarded = mcpForwardHeaders(inbound, { method: "tools/call", params: { name: "aws.list_buckets" } });
  assert.equal(forwarded.get("mcp-protocol-version"), "2026-07-28");
  assert.equal(forwarded.get("mcp-method"), "tools/call");
  assert.equal(forwarded.get("mcp-name"), "aws.list_buckets");
  assert.equal(forwarded.get("mcp-param-region"), "us-east-1");
  assert.equal(forwarded.has("authorization"), false);
  assert.equal(mcpForwardHeaders(inbound, { method: "server/discover" }).has("mcp-name"), false);
});

test("MCP proxy injects only the stored credential and blocks unapproved calls", async () => {
  const original = globalThis.fetch;
  const secret = "s".repeat(40);
  const grant = { serverUrl: "https://mcp.example.org/mcp", toolsJson: '["aws.list_buckets"]',
    credentialRef: await encryptToken("upstream-secret", "mcp", secret) };
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return Response.json({ jsonrpc: "2.0", result: "ok" }, { headers: { "mcp-session-id": "session" } });
    };
    const request = name => new Request("https://fava.example/mcp", { method: "POST",
      headers: { Authorization: "Bearer run-capability", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: {} } }) });
    const allowed = await forwardMcp(request("aws.list_buckets"), grant, secret);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("mcp-session-id"), "session");
    assert.equal(allowed.headers.get("cache-control"), "no-store");
    assert.equal(calls[0].url, grant.serverUrl);
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer upstream-secret");
    assert.equal(calls[0].init.headers.get("mcp-name"), "aws.list_buckets");
    assert.equal((await forwardMcp(request("aws.delete_bucket"), grant, secret)).status, 403);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; }
});
