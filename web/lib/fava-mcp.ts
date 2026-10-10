import { decryptToken } from "./fava-cloudflare.ts";

export type McpGrant = { serverUrl: string; toolsJson: string; credentialRef: string | null };

export function mcpServerUrl(value: string) {
  if (value.length > 512) throw Error("MCP server URL is too long");
  let url: URL;
  try { url = new URL(value); }
  catch { throw Error("Enter an HTTPS MCP server URL"); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.port ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host) ||
    ["local", "localhost", "internal", "invalid", "test", "example"].some(suffix => host.endsWith(`.${suffix}`)))
    throw Error("Use a public HTTPS MCP server URL without credentials or query parameters");
  return url.toString();
}

export function mcpTools(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 ||
    value.some(tool => typeof tool !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(tool)) ||
    new Set(value).size !== value.length) throw Error("Choose 1–16 distinct MCP tool names");
  return value as string[];
}

export function allowedMcpRequest(value: unknown, tools: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as { method?: unknown; params?: { name?: unknown } };
  if (request.method === "tools/call") return typeof request.params?.name === "string" &&
    tools.includes(request.params.name);
  return ["initialize", "notifications/initialized", "ping", "server/discover", "tools/list"].includes(String(request.method));
}

export function mcpForwardHeaders(inbound: Headers, value?: unknown) {
  const headers = new Headers();
  for (const name of ["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"])
    if (inbound.has(name)) headers.set(name, inbound.get(name)!);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const request = value as { method?: unknown; params?: { name?: unknown } };
    if (typeof request.method === "string") headers.set("mcp-method", request.method);
    if (request.method === "tools/call" && typeof request.params?.name === "string")
      headers.set("mcp-name", request.params.name);
    inbound.forEach((content, name) => {
      if (name.startsWith("mcp-param-")) headers.set(name, content);
    });
  }
  return headers;
}

async function limitedBody(request: Request) {
  if (Number(request.headers.get("content-length")) > 256_000) throw Error("MCP request is too large");
  const reader = request.body?.getReader();
  if (!reader) throw Error("MCP request is empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 256_000) { await reader.cancel(); throw Error("MCP request is too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function forwardMcp(request: Request, grant: McpGrant, encryptionSecret: string) {
  try {
    const target = mcpServerUrl(grant.serverUrl);
    const tools = mcpTools(JSON.parse(grant.toolsJson));
    let body: Uint8Array | undefined;
    let rpc: unknown;
    if (request.method === "POST") {
      body = await limitedBody(request);
      rpc = JSON.parse(new TextDecoder().decode(body));
      if (!allowedMcpRequest(rpc, tools))
        return new Response("MCP tool is not approved", { status: 403 });
    }
    const headers = mcpForwardHeaders(request.headers, rpc);
    if (grant.credentialRef)
      headers.set("authorization", `Bearer ${await decryptToken(grant.credentialRef, "mcp", encryptionSecret)}`);
    const upstream = await fetch(target, { method: request.method, headers, body: body?.buffer as ArrayBuffer | undefined,
      redirect: "manual", cache: "no-store" });
    if (upstream.status >= 300 && upstream.status < 400)
      return new Response("MCP server redirect is not allowed", { status: 502 });
    const responseHeaders = new Headers();
    for (const name of ["content-type", "mcp-session-id"])
      if (upstream.headers.has(name)) responseHeaders.set(name, upstream.headers.get(name)!);
    responseHeaders.set("cache-control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    console.error("MCP proxy request failed", error instanceof Error ? error.name : "unknown");
    return new Response("MCP server request failed", { status: 502 });
  }
}
