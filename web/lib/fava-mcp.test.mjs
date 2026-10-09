import test from "node:test";
import assert from "node:assert/strict";
import { allowedMcpRequest, mcpServerUrl, mcpTools } from "./fava-mcp.ts";

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
