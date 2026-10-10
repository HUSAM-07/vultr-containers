"use client";

import { useEffect, useState } from "react";
import { RiPlugLine, RiRefreshLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";

type Grant = { id: string; serverUrl: string; allowedTools: string[] };
type DiscoveredTool = { name: string; description: string };
type State = { grants: Grant[]; canManage: boolean };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "MCP connection failed");
  return value as T;
}

export function McpGrantsPanel({ repository }: { repository: string }) {
  const [state, setState] = useState<State | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [toolNames, setToolNames] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [discovered, setDiscovered] = useState<DiscoveredTool[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    setState(await request<State>(`/api/mcp?repo=${encodeURIComponent(repository)}`));
  }

  useEffect(() => {
    let current = true;
    request<State>(`/api/mcp?repo=${encodeURIComponent(repository)}`)
      .then(value => { if (current) { setState(value); setError(""); } })
      .catch(cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [repository]);

  async function change(action: "add" | "revoke", id?: string) {
    setBusy(true); setError("");
    try {
      const next = await request<{ grants: Grant[] }>("/api/mcp", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, repo: repository, id,
          serverUrl: serverUrl.trim(), allowedTools: toolNames.split(",").map(name => name.trim()),
          bearerToken: bearerToken.trim() || null }) });
      setState(current => current && { ...current, grants: next.grants });
      if (action === "add") { setServerUrl(""); setToolNames(""); setBearerToken(""); setDiscovered(null); }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function discover() {
    setBusy(true); setError(""); setDiscovered(null); setToolNames("");
    try {
      const result = await request<{ tools: DiscoveredTool[] }>("/api/mcp", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "discover", repo: repository,
          serverUrl: serverUrl.trim(), bearerToken: bearerToken.trim() || null }) });
      setDiscovered(result.tools);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  function toggleTool(name: string) {
    const selected = toolNames.split(",").map(value => value.trim()).filter(Boolean);
    setToolNames(selected.includes(name) ? selected.filter(value => value !== name).join(", ")
      : [...selected, name].join(", "));
  }

  return <section className="mt-6 border-t border-separator-border pt-5" aria-label="MCP connections">
    <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-body-medium"><RiPlugLine className="size-5 text-accent-600" aria-hidden />MCP connections</h3><Button variant="ghost" size="xs" iconOnly leadingIcon={RiRefreshLine} aria-label="Refresh MCP connections" onClick={() => void refresh().catch(cause => setError((cause as Error).message))} /></div>
    <p className="mt-2 text-body-regular text-text-secondary">Approve remote tools for this project. Runs pin these connections when a spec merges. Revoking a connection stops tool calls immediately.</p>
    {error && <p role="alert" className="mt-3 text-body-regular text-text-error-primary">{error}</p>}
    {state && <div className="mt-4 grid gap-3">
      {state.grants.length ? <ul className="grid gap-2">{state.grants.map(grant => <li key={grant.id} className="rounded-xl border border-border-button-default bg-background-primary-default p-3"><p className="break-all font-mono text-caption-1-regular" dir="ltr">{grant.serverUrl}</p><p className="mt-1 break-words text-caption-1-regular text-text-secondary">Tools: {grant.allowedTools.join(", ")}</p>{state.canManage && <Button variant="ghost" size="xs" disabled={busy} onClick={() => void change("revoke", grant.id)}>Revoke</Button>}</li>)}</ul> : <p className="text-body-regular text-text-tertiary">No MCP servers connected.</p>}
      {state.canManage && <div className="grid gap-3 rounded-xl border border-border-button-default bg-background-primary-default p-3">
        <Input label="Remote MCP URL" type="url" inputDir="ltr" value={serverUrl} onChange={value => { setServerUrl(value); setDiscovered(null); setToolNames(""); }} placeholder="https://example.com/mcp" />
        <Input label="Bearer token (optional)" type="password" value={bearerToken} onChange={value => { setBearerToken(value); setDiscovered(null); setToolNames(""); }} />
        <Button size="small" variant="secondary" disabled={busy || !serverUrl.trim()} onClick={() => void discover()}>Discover tools</Button>
        <p className="text-caption-1-regular text-text-tertiary">Fava contacts this server with the token to list its tools. Discovery does not run a tool.</p>
        {discovered && <div role="group" aria-label="Available MCP tools" className="grid gap-2">
          <p className="text-caption-1-regular text-text-secondary">Choose up to 16 tools to approve for agent runs.</p>
          {discovered.map(tool => { const selected = toolNames.split(",").map(value => value.trim()).includes(tool.name);
            return <Button key={tool.name} size="small" variant={selected ? "primary" : "secondary"} aria-pressed={selected}
              disabled={busy || !selected && toolNames.split(",").map(value => value.trim()).filter(Boolean).length >= 16}
              className="!h-auto !min-h-9 !justify-start !whitespace-normal !text-start" onClick={() => toggleTool(tool.name)}>
              <span className="grid gap-1"><span className="font-mono">{tool.name}</span>{tool.description && <span className="text-caption-1-regular">{tool.description}</span>}</span>
            </Button>; })}
          {!discovered.length && <p className="text-caption-1-regular text-text-tertiary">This server returned no selectable tools.</p>}
        </div>}
        <Input label="Allowed tool names" inputDir="ltr" value={toolNames} onChange={setToolNames} placeholder="search, read_file" hint="Select discovered tools or enter 1–16 comma-separated names manually." />
        <Button size="small" disabled={busy || !serverUrl || !toolNames || state.grants.length >= 8} onClick={() => void change("add")}>Connect MCP server</Button>
      </div>}
    </div>}
  </section>;
}
