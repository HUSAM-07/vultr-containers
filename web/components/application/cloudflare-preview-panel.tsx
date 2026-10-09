"use client";

import { useEffect, useState } from "react";
import { RiCloudLine, RiExternalLinkLine, RiRefreshLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";

type State = { connected: boolean; accountId: string | null; workers: { name: string; tag: string }[];
  preview: { workerName: string; triggerUuid: string } | null };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "Cloudflare request failed");
  return value as T;
}

export function CloudflarePreviewPanel({ repository }: { repository: string }) {
  const [state, setState] = useState<State | null>(null);
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [workerName, setWorkerName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    const next = await request<State>(`/api/cloudflare?repo=${encodeURIComponent(repository)}`);
    setState(next);
    setWorkerName(current => next.workers.some(worker => worker.name === current) ? current : next.preview?.workerName || next.workers[0]?.name || "");
  }

  useEffect(() => {
    let current = true;
    request<State>(`/api/cloudflare?repo=${encodeURIComponent(repository)}`)
      .then(value => { if (current) { setState(value); setWorkerName(value.preview?.workerName || value.workers[0]?.name || ""); setError(""); } })
      .catch(cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [repository]);

  async function act(action: "connect" | "enable" | "disconnect") {
    setBusy(true); setError("");
    try {
      await request("/api/cloudflare", action === "disconnect" ? { method: "DELETE" } : {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, repo: repository, cloudflareAccountId: accountId.trim(), token: token.trim(), workerName }),
      });
      setToken("");
      await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="mt-6 border-t border-separator-border pt-5" aria-label="Cloudflare Worker Previews">
    <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-body-medium"><RiCloudLine className="size-5 text-accent-600" aria-hidden />Worker Previews</h3><Button variant="ghost" size="xs" iconOnly leadingIcon={RiRefreshLine} aria-label="Refresh Cloudflare connection" onClick={() => void refresh().catch(cause => setError((cause as Error).message))} /></div>
    <p className="mt-2 text-body-regular text-text-secondary">Give each implementation branch an isolated Cloudflare Worker URL.</p>
    {error && <p role="alert" className="mt-3 text-body-regular text-text-error-primary">{error}</p>}
    {!state?.connected ? <div className="mt-4 grid gap-3">
      <Input label="Cloudflare account ID" value={accountId} onChange={setAccountId} placeholder="32-character account ID" />
      <Input label="User API token" type="password" value={token} onChange={setToken} placeholder="Workers Builds Configuration: Edit" />
      <p className="text-caption-1-regular text-text-tertiary">Use a user-scoped token with Workers Scripts Read and Workers Builds Configuration Edit. Fava encrypts it before storing it.</p>
      <Button size="small" disabled={busy || !accountId || !token} onClick={() => void act("connect")}>Connect Cloudflare</Button>
      <a className="inline-flex items-center gap-1 text-caption-1-semibold text-accent-600 hover:underline" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Create an API token <RiExternalLinkLine className="size-4" aria-hidden /></a>
    </div> : <div className="mt-4 grid gap-3">
      <p className="text-caption-1-regular text-text-secondary">Connected account <span className="font-mono">{state.accountId}</span></p>
      {state.workers.length ? <><p className="text-body-medium">Choose a Worker</p><div role="group" aria-label="Cloudflare Worker" className="flex flex-wrap gap-2">{state.workers.map(worker => <Button key={worker.tag} size="small" variant={workerName === worker.name ? "primary" : "secondary"} aria-pressed={workerName === worker.name} onClick={() => setWorkerName(worker.name)}>{worker.name}</Button>)}</div></> : <p className="text-body-regular text-text-secondary">No Workers are deployed in this account yet.</p>}
      <p className="text-caption-1-regular text-text-tertiary">The repository needs a root Wrangler config with a <code>previews</code> block and separate Preview D1, R2, and KV resources. Set Preview secrets separately, and connect the Worker to this GitHub repository in Cloudflare Builds first.</p>
      {state.preview ? <p role="status" className="rounded-xl border border-border-button-default bg-background-primary-default p-3 text-body-regular">Previews enabled for <strong>{state.preview.workerName}</strong>. Branch pushes will use <code>npx wrangler preview</code>.</p> : <Button size="small" disabled={busy || !workerName} onClick={() => void act("enable")}>Enable branch Previews</Button>}
      <div className="flex flex-wrap gap-3"><a className="inline-flex items-center gap-1 text-caption-1-semibold text-accent-600 hover:underline" href={`https://dash.cloudflare.com/${state.accountId}/workers/services/view/${encodeURIComponent(state.preview?.workerName || workerName)}`} target="_blank" rel="noreferrer">Open Worker <RiExternalLinkLine className="size-4" aria-hidden /></a><Button variant="ghost" size="xs" disabled={busy} onClick={() => void act("disconnect")}>Disconnect Fava access</Button></div>
      <p className="text-caption-1-regular text-text-tertiary">Disconnecting Fava access does not stop Cloudflare Builds. Disable its trigger in Cloudflare if needed.</p>
    </div>}
  </section>;
}
