"use client";

import { useEffect, useState } from "react";
import { RiTeamLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";

type Member = { githubId: number; login: string; role: "admin" | "editor" | "viewer"; signedIn: number };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "Project members are unavailable");
  return value as T;
}

export function ProjectMembersPanel({ repository }: { repository: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<Member["role"]>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    request<Member[]>(`/api/members?repo=${encodeURIComponent(repository)}`)
      .then(value => { if (current) setMembers(value); })
      .catch(cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [repository]);

  async function change(action: "add" | "remove", member?: Member) {
    setBusy(true); setError("");
    try {
      setMembers(await request<Member[]>("/api/members", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, repo: repository, login: login.trim(), role, githubId: member?.githubId }) }));
      if (action === "add") setLogin("");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="mt-6 border-t border-separator-border pt-5" aria-label="Project members">
    <h3 className="flex items-center gap-2 text-body-medium"><RiTeamLine className="size-5 text-accent-600" aria-hidden />Project members</h3>
    <p className="mt-2 text-body-regular text-text-secondary">Add a GitHub user now; their project access becomes available after they sign in to Fava and authorize this repository. Admins manage project settings; editors write specs and project skills; viewers inspect runs.</p>
    {error && <p role="alert" className="mt-3 text-body-regular text-text-error-primary">{error}</p>}
    <div className="mt-4 grid gap-3"><Input label="GitHub username" value={login} onChange={setLogin} placeholder="octocat" />
      <div role="group" aria-label="Project role" className="flex flex-wrap gap-2">{(["viewer", "editor", "admin"] as const).map(option =>
        <Button key={option} size="xs" variant={role === option ? "primary" : "secondary"} aria-pressed={role === option}
          onClick={() => setRole(option)}>{option}</Button>)}</div>
      <Button size="small" disabled={busy || !login.trim()} onClick={() => void change("add")}>Add or update member</Button>
    </div>
    {members.length ? <ul className="mt-4 grid gap-2">{members.map(member => <li key={member.githubId}
      className="flex items-center justify-between gap-2 rounded-xl border border-border-button-default bg-background-primary-default p-3">
      <span className="min-w-0 truncate text-body-regular">{member.login} · {member.role}{!member.signedIn && " · Awaiting sign-in"}</span>
      <Button variant="ghost" size="xs" disabled={busy} onClick={() => void change("remove", member)}>Remove</Button>
    </li>)}</ul> : <p className="mt-4 text-body-regular text-text-tertiary">Only workspace members have access so far.</p>}
  </section>;
}
