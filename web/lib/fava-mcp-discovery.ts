import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mcpServerUrl } from "./fava-mcp.ts";

export async function discoverMcpTools(value: string, bearerToken: string | null) {
  const endpoint = mcpServerUrl(value);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 10_000);
  let bytes = 0;
  const client = new Client({ name: "fava", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {} },
    fetch: async (input, init) => {
      if ((input instanceof Request ? input.url : String(input)) !== endpoint)
        throw Error("MCP discovery cannot follow another URL");
      const response = await fetch(input, { ...init, redirect: "manual",
        signal: init?.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal });
      if (response.status >= 300 && response.status < 400) throw Error("MCP discovery redirect is not allowed");
      if (Number(response.headers.get("content-length")) > 256_000) throw Error("MCP tool list is too large");
      if (!response.body) return response;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 1_000_000) throw Error("MCP discovery response is too large");
          controller.enqueue(chunk);
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    if (tools.length > 100) throw Error("MCP tool list exceeds 100 tools");
    return tools.filter(tool => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(tool.name))
      .map(tool => ({ name: tool.name, description: tool.description?.slice(0, 300) || "" }));
  } finally { clearTimeout(timer); await client.close().catch(() => {}); }
}
