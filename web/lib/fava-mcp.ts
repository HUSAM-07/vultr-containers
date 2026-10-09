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
