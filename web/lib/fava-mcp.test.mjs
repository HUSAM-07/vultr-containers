import test from "node:test";
import assert from "node:assert/strict";
import { allowedMcpRequest, mcpForwardHeaders, mcpServerUrl, mcpTools } from "./fava-mcp.ts";

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
