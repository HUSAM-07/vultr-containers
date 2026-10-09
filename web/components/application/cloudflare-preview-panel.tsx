"use client";

import { useEffect, useState } from "react";
import { RiCloudLine, RiExternalLinkLine, RiRefreshLine } from "@remixicon/react";
import { Button, ButtonLink } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";

type State = { connected: boolean; canManage: boolean; accountId: string | null;
  oauthAvailable: boolean; authMethod: "token" | "oauth" | null;
  workers: { name: string; tag: string }[];
  buildTokens: { id: string; name: string }[];
  preview: { workerName: string; triggerUuid?: string } | null;
  builds: { branch: string; buildUuid: string; status: string; outcome: string | null; url: string | null }[] };

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
  const [buildTokenId, setBuildTokenId] = useState("");
  const [rootDirectory, setRootDirectory] = useState("/");
  const [buildCommand, setBuildCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    const next = await request<State>(`/api/cloudflare?repo=${encodeURIComponent(repository)}`);
    setState(next);
    setWorkerName(current => next.workers.some(worker => worker.name === current) ? current : next.preview?.workerName || next.workers[0]?.name || "");
    setBuildTokenId(current => next.buildTokens.some(item => item.id === current) ? current : "");
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
      await request(action === "disconnect" ? `/api/cloudflare?repo=${encodeURIComponent(repository)}` : "/api/cloudflare",
        action === "disconnect" ? { method: "DELETE" } : {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, repo: repository, cloudflareAccountId: accountId.trim(), token: token.trim(), workerName,
          buildTokenId, rootDirectory: rootDirectory.trim(), buildCommand: buildCommand.trim() }),
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
    {!state ? null : !state.connected && !state.canManage ? <p className="mt-4 text-body-regular text-text-secondary">A project admin can connect Cloudflare to enable branch Previews.</p> : !state.connected ? <div className="mt-4 grid gap-3">
      <Input label="Cloudflare account ID" value={accountId} onChange={setAccountId} placeholder="32-character account ID" />
      {state.oauthAvailable && <><ButtonLink size="small" href={`/api/cloudflare/oauth/start?repo=${encodeURIComponent(repository)}&account=${encodeURIComponent(accountId.trim())}`}
        aria-disabled={busy || !/^[a-f0-9]{32}$/i.test(accountId.trim())}
        onClick={event => { if (busy || !/^[a-f0-9]{32}$/i.test(accountId.trim())) event.preventDefault(); }}>Authorize with Cloudflare</ButtonLink>
        <p className="text-caption-1-regular text-text-tertiary">Grant Fava Workers Content Read-Only and Workers CI Write for the selected Cloudflare account. Fava stores encrypted, refreshable credentials for this workspace.</p></>}
      <Input label="User API token" type="password" value={token} onChange={setToken} placeholder="Workers Builds Configuration: Edit" />
      <p className="text-caption-1-regular text-text-tertiary">Use a user-scoped token with Workers Scripts Read and Workers Builds Configuration Edit. Fava encrypts it for this workspace; its project administrators can use this connection.</p>
      <Button size="small" disabled={busy || !accountId || !token} onClick={() => void act("connect")}>Connect with API token</Button>
      <a className="inline-flex items-center gap-1 text-caption-1-semibold text-accent-600 hover:underline" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Create an API token <RiExternalLinkLine className="size-4" aria-hidden /></a>
    </div> : <div className="mt-4 grid gap-3">
      {state.canManage && <><p className="text-caption-1-regular text-text-secondary">Connected account <span className="font-mono">{state.accountId}</span>{state.authMethod === "oauth" ? " via Cloudflare authorization" : " via API token"}</p>
        {state.workers.length ? <><p className="text-body-medium">Choose a Worker</p><div role="group" aria-label="Cloudflare Worker" className="flex flex-wrap gap-2">{state.workers.map(worker => <Button key={worker.tag} size="small" variant={workerName === worker.name ? "primary" : "secondary"} aria-pressed={workerName === worker.name} onClick={() => setWorkerName(worker.name)}>{worker.name}</Button>)}</div></> : <p className="text-body-regular text-text-secondary">No Workers are deployed in this account yet.</p>}
        {state.accountId && <div className="grid gap-2"><p className="text-body-regular text-text-secondary">Need a Worker for this project? Import its GitHub repository in Cloudflare, deploy it, then refresh this list.</p><ButtonLink size="small" variant="secondary" href={`https://dash.cloudflare.com/${state.accountId}/workers-and-pages/create`} target="_blank" rel="noreferrer" trailingIcon={RiExternalLinkLine}>Import repository as Worker</ButtonLink></div>}
        {!state.preview && state.workers.length > 0 && <div className="grid gap-3 rounded-xl border border-border-button-default bg-background-primary-default p-3">
          <p className="text-body-medium">Connect this repository to the Worker</p>
          <p className="text-caption-1-regular text-text-secondary">If the Worker already builds from this repository, Fava reuses its production settings. Otherwise, choose a Cloudflare Builds deployment token and enter the repository build settings.</p>
          {state.buildTokens.length > 0 ? <div role="group" aria-label="Cloudflare Builds deployment token" className="flex flex-wrap gap-2">{state.buildTokens.map(item => <Button key={item.id} size="small" variant={buildTokenId === item.id ? "primary" : "secondary"} aria-pressed={buildTokenId === item.id} onClick={() => setBuildTokenId(item.id)}>{item.name || item.id}</Button>)}</div>
            : <p className="text-caption-1-regular text-text-secondary">No deployment token is available. Create one in Cloudflare Worker Builds before connecting a new repository.</p>}
          <Input label="Worker root directory" value={rootDirectory} onChange={setRootDirectory} placeholder="/" />
          <Input label="Build command, if needed" value={buildCommand} onChange={setBuildCommand} placeholder="npm run build" />
        </div>}
        <p className="text-caption-1-regular text-text-tertiary">The repository needs Wrangler 4.135.0 or later and a root Wrangler config with a <code>previews</code> block. Configure Preview variables, API bindings, Worker Loaders, define values, containers, Durable Object bindings, and separate account resources such as D1, R2, KV, and queues. Set Preview secrets separately. Cloudflare&apos;s GitHub App must be installed for the repository. Branch Previews that reference the same account resource share its data.</p></>}
      {state.preview ? <p role="status" className="rounded-xl border border-border-button-default bg-background-primary-default p-3 text-body-regular">Previews enabled for <strong>{state.preview.workerName}</strong>. Branch pushes will use <code>npx wrangler preview</code>.</p> : state.canManage ? <Button size="small" disabled={busy || !workerName} onClick={() => void act("enable")}>Connect repository and enable Previews</Button> : <p className="text-body-regular text-text-secondary">A project admin can enable branch Previews.</p>}
      <p className="text-caption-1-regular text-text-tertiary">Preview URLs are public by default. Protect sensitive projects with <a className="text-accent-600 hover:underline" href="https://developers.cloudflare.com/workers/previews/#access-control" target="_blank" rel="noreferrer">Cloudflare Access</a> and use separate Preview data resources.</p>
      {state.preview && <div className="grid gap-2" aria-label="Recent branch Previews"><h4 className="text-body-medium">Recent branches</h4>{state.builds.length ? state.builds.map(build => <div key={build.buildUuid} className="flex items-center justify-between gap-2 rounded-xl border border-border-button-default bg-background-primary-default p-3 text-body-regular"><span className="min-w-0 truncate font-mono">{build.branch}</span>{build.url ? <a href={build.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-accent-600 hover:underline">Open Preview <RiExternalLinkLine className="size-4" aria-hidden /></a> : <span className="shrink-0 text-text-tertiary">{build.outcome || build.status}</span>}</div>) : <p className="text-body-regular text-text-secondary">No branch builds yet. Push a branch to create its Preview.</p>}</div>}
      {state.canManage && <><div className="flex flex-wrap gap-3"><a className="inline-flex items-center gap-1 text-caption-1-semibold text-accent-600 hover:underline" href={`https://dash.cloudflare.com/${state.accountId}/workers/services/view/${encodeURIComponent(state.preview?.workerName || workerName)}`} target="_blank" rel="noreferrer">Open Worker <RiExternalLinkLine className="size-4" aria-hidden /></a><Button variant="ghost" size="xs" disabled={busy} onClick={() => void act("disconnect")}>Disconnect Fava access</Button></div>
        <p className="text-caption-1-regular text-text-tertiary">Disconnecting Fava access does not stop Cloudflare Builds. Disable its trigger in Cloudflare if needed.</p></>}
    </div>}
  </section>;
}
