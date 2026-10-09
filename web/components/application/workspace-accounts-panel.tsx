"use client";

import { useEffect, useState } from "react";
import { RiTeamLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";

export type Workspace = { id: string; name: string; role: "owner" | "admin" | "editor" | "viewer" };
type Member = { githubId: number; login: string; role: Workspace["role"] };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "Workspace request failed");
  return value as T;
}

export function WorkspaceAccountsPanel({ accounts, selectedId, onSelect, onCreated }: {
  accounts: Workspace[]; selectedId: string; onSelect: (id: string) => void;
  onCreated: (account: Workspace) => void }) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<"admin" | "editor" | "viewer">("editor");
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = accounts.find(account => account.id === selectedId);
  const canManage = selected?.role === "owner" || selected?.role === "admin";

  useEffect(() => {
    if (!canManage) return;
    let current = true;
    request<Member[]>(`/api/accounts?accountId=${encodeURIComponent(selectedId)}`)
      .then(value => { if (current) setMembers(value); })
      .catch(cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [selectedId, canManage]);

  async function create() {
    setBusy(true); setError("");
    try {
      const account = await request<Workspace>("/api/accounts", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: name.trim() }) });
      setMembers([]); onCreated(account); setName("");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function change(action: "member" | "remove", member?: Member) {
    setBusy(true); setError("");
    try {
      setMembers(await request<Member[]>("/api/accounts", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, accountId: selectedId, login: login.trim(), role,
          githubId: member?.githubId }) }));
      if (action === "member") setLogin("");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="mt-7 border-t border-separator-border pt-5" aria-label="Workspaces">
    <h2 className="flex items-center gap-2 text-caption-1-semibold uppercase tracking-widest text-text-tertiary"><RiTeamLine className="size-4" aria-hidden />Workspaces</h2>
    <div className="mt-3 grid gap-1">{accounts.map(account =>
      <Button key={account.id} variant={selectedId === account.id ? "secondary" : "ghost"} size="small"
        className="!h-auto !min-h-9 !justify-start !whitespace-normal !text-start"
        onClick={() => { if (account.id !== selectedId) { setError(""); setMembers([]); onSelect(account.id); } }}>
        {account.name} · {account.role}
      </Button>)}</div>
    <div className="mt-3 grid gap-2"><Input label="New team workspace" value={name} onChange={setName} placeholder="Product team" />
      <Button size="xs" variant="secondary" disabled={busy || name.trim().length < 2} onClick={() => void create()}>Create workspace</Button></div>
    {error && <p role="alert" className="mt-3 text-caption-1-regular text-text-error-primary">{error}</p>}
    {canManage && <div className="mt-5 border-t border-separator-border pt-4">
      <h3 className="text-body-medium">Workspace members</h3>
      <p className="mt-1 text-caption-1-regular text-text-tertiary">Members must sign in to Fava first. Removing one also revokes their project grants here.</p>
      {members.length > 0 && <ul className="mt-3 grid gap-2">{members.map(member => <li key={member.githubId}
        className="flex items-center justify-between gap-2 text-caption-1-regular">
        <span className="min-w-0 truncate">{member.login} · {member.role}</span>
        {member.role !== "owner" && <Button variant="ghost" size="xs" disabled={busy}
          onClick={() => void change("remove", member)}>Remove</Button>}
      </li>)}</ul>}
      <div className="mt-3 grid gap-2"><Input label="GitHub username" value={login} onChange={setLogin} placeholder="octocat" />
        <div role="group" aria-label="Workspace role" className="flex flex-wrap gap-1">{(["viewer", "editor", "admin"] as const).map(option =>
          <Button key={option} size="xs" variant={role === option ? "primary" : "secondary"} aria-pressed={role === option}
            onClick={() => setRole(option)}>{option}</Button>)}</div>
        <Button size="xs" disabled={busy || !login.trim()} onClick={() => void change("member")}>Add or update member</Button>
      </div>
    </div>}
  </section>;
}
