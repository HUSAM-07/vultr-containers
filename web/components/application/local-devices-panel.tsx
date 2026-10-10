"use client";

import { useEffect, useState } from "react";
import { RiComputerLine, RiRefreshLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";

type Device = { id: string; label: string; expiresAt: number; revokedAt: number | null };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "Device request failed");
  return value as T;
}

export function LocalDevicesPanel({ repository }: { repository: string }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function refresh() {
    const result = await request<{ devices: Device[] }>(`/api/devices?repo=${encodeURIComponent(repository)}`);
    setDevices(result.devices.filter(device => !device.revokedAt && device.expiresAt > Date.now()));
  }

  useEffect(() => {
    let current = true;
    request<{ devices: Device[] }>(`/api/devices?repo=${encodeURIComponent(repository)}`)
      .then(value => { if (current) setDevices(value.devices.filter(device => !device.revokedAt && device.expiresAt > Date.now())); })
      .catch(cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [repository]);

  async function change(action: "pair" | "rotate" | "revoke", id?: string) {
    setBusy(true); setError(""); setCopied(false);
    try {
      const result = await request<{ token?: string }>("/api/devices", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, repo: repository, ...(action === "pair" ? { label } : { id }) }) });
      setToken(result.token || "");
      if (action === "pair") setLabel("");
      await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function copyToken() {
    try { await navigator.clipboard.writeText(token); setCopied(true); }
    catch { setError("Clipboard access failed. Select and copy the token manually."); }
  }

  return <section className="mt-6 border-t border-separator-border pt-5" aria-label="Local agent devices">
    <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-body-medium"><RiComputerLine className="size-5 text-accent-600" aria-hidden />Local agent devices</h3><Button variant="ghost" size="xs" iconOnly leadingIcon={RiRefreshLine} aria-label="Refresh local devices" onClick={() => void refresh().catch(cause => setError((cause as Error).message))} /></div>
    <p className="mt-2 text-body-regular text-text-secondary">Pair a computer signed in to Codex or Claude Code to run this project with your own subscription.</p>
    {error && <p role="alert" className="mt-3 text-caption-1-regular text-text-error-primary">{error}</p>}
    {token && <div role="status" className="mt-3 grid gap-2 rounded-xl border border-border-button-default bg-background-primary-default p-3">
      <p className="text-body-medium">Save this token now. Fava will not show it again.</p>
      <code className="break-all text-caption-1-regular" dir="ltr">{token}</code>
      <div className="flex flex-wrap gap-2"><Button size="xs" variant="secondary" onClick={() => void copyToken()}>{copied ? "Copied" : "Copy token"}</Button><Button size="xs" variant="ghost" onClick={() => { setToken(""); setCopied(false); }}>Dismiss token</Button></div>
      <p className="text-caption-1-regular text-text-secondary">Use it as FAVA_DEVICE_TOKEN with <code>npm run companion</code> from the Fava repository. Set FAVA_URL to this site&apos;s origin.</p>
    </div>}
    {devices.length ? <ul className="mt-3 grid gap-2">{devices.map(device => <li key={device.id} className="rounded-xl border border-border-button-default bg-background-primary-default p-3">
      <p className="text-body-medium">{device.label}</p><p className="mt-1 text-caption-1-regular text-text-tertiary">Expires {new Date(device.expiresAt).toLocaleDateString()}</p>
      <div className="mt-2 flex gap-2"><Button size="xs" variant="ghost" disabled={busy} onClick={() => void change("rotate", device.id)}>Rotate token</Button><Button size="xs" variant="ghost" disabled={busy} onClick={() => void change("revoke", device.id)}>Revoke</Button></div>
    </li>)}</ul> : <p className="mt-3 text-body-regular text-text-tertiary">No active computers are paired with this project.</p>}
    <div className="mt-3 grid gap-2"><Input label="Computer name" size="small" value={label} onChange={setLabel} placeholder="My laptop" maxLength={80} /><Button size="xs" variant="secondary" disabled={busy || label.trim().length < 2 || devices.length >= 10} onClick={() => void change("pair")}>Pair computer</Button></div>
  </section>;
}
