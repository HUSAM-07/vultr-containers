"use client";

import { useEffect, useState } from "react";
import { RiBookOpenLine, RiExternalLinkLine, RiRefreshLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Textarea } from "@/components/base/textarea/textarea";

type Library = { available: { path: string; size: number }[]; selected: {
  id: string; path: string; commitSha: string; projectId: string | null; sourceRepository: string }[] };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "Skill request failed");
  return value as T;
}

export function SkillsPanel({ repository, canEdit, canManageWorkspace }: {
  repository: string; canEdit: boolean; canManageWorkspace: boolean }) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillContent, setSkillContent] = useState("");
  const [proposal, setProposal] = useState<{ url: string; number: number; path: string } | null>(null);

  async function refresh() {
    setLibrary(await request<Library>(`/api/skills?repo=${encodeURIComponent(repository)}`));
  }

  useEffect(() => {
    let current = true;
    request<Library>(`/api/skills?repo=${encodeURIComponent(repository)}`)
      .then(value => { if (current) { setLibrary(value); setError(""); } })
      .catch(cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [repository]);

  async function change(action: "add" | "remove", payload: { path?: string; scope?: "project" | "workspace"; id?: string }) {
    setBusy(true); setError("");
    try {
      await request("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, repo: repository, ...payload }) });
      await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function propose() {
    setBusy(true); setError(""); setProposal(null);
    try {
      const result = await request<{ url: string; number: number; path: string }>("/api/skills", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "propose", repo: repository, name: skillName, content: skillContent }),
      });
      setProposal(result); setSkillName(""); setSkillContent("");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="mt-6 border-t border-separator-border pt-5" aria-label="Skills library">
    <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-body-medium"><RiBookOpenLine className="size-5 text-accent-600" aria-hidden />Skills library</h3><Button variant="ghost" size="xs" iconOnly leadingIcon={RiRefreshLine} aria-label="Refresh skills" onClick={() => void refresh().catch(cause => setError((cause as Error).message))} /></div>
    <p className="mt-2 text-body-regular text-text-secondary">Select repository skills for this project or share them across your workspace. Each run pins their versions when its spec merges.</p>
    {error && <p role="alert" className="mt-3 text-body-regular text-text-error-primary">{error}</p>}
    {library && <div className="mt-4 grid gap-4">
      <div><h4 className="text-caption-1-semibold uppercase tracking-widest text-text-tertiary">Selected</h4>{library.selected.length ? <ul className="mt-2 grid gap-2">{library.selected.map(skill => <li key={skill.id} className="rounded-xl border border-border-button-default bg-background-primary-default p-3"><p className="break-all font-mono text-caption-1-regular">{skill.path}</p><p className="mt-1 text-caption-1-regular text-text-secondary">{skill.projectId ? "Project" : "Workspace"} · {skill.sourceRepository} · {skill.commitSha.slice(0, 7)}</p>{canEdit && (skill.projectId || canManageWorkspace) && <Button variant="ghost" size="xs" disabled={busy} onClick={() => void change("remove", { id: skill.id })}>Remove</Button>}</li>)}</ul> : <p className="mt-2 text-body-regular text-text-tertiary">No skills selected yet.</p>}</div>
      <div><h4 className="text-caption-1-semibold uppercase tracking-widest text-text-tertiary">Available in this repository</h4>{library.available.length ? <ul className="mt-2 grid gap-2">{library.available.map(skill => <li key={skill.path} className="rounded-xl border border-border-button-default bg-background-primary-default p-3"><p className="break-all font-mono text-caption-1-regular">{skill.path}</p>{canEdit && <div className="mt-2 flex flex-wrap gap-2"><Button size="xs" variant="secondary" disabled={busy || library.selected.some(item => item.path === skill.path && item.sourceRepository === repository && item.projectId !== null)} onClick={() => void change("add", { path: skill.path, scope: "project" })}>Use in project</Button>{canManageWorkspace && <Button size="xs" variant="secondary" disabled={busy || library.selected.some(item => item.path === skill.path && item.sourceRepository === repository && item.projectId === null)} onClick={() => void change("add", { path: skill.path, scope: "workspace" })}>Share across workspace</Button>}</div>}</li>)}</ul> : <p className="mt-2 text-body-regular text-text-tertiary">Add Markdown files under <code>.fava/skills/</code> in this repository to make them selectable.</p>}</div>
      {canEdit && <div className="grid gap-3 rounded-xl border border-border-button-default bg-background-primary-default p-3">
        <h4 className="text-body-medium">Write a new skill</h4>
        <p className="text-caption-1-regular text-text-secondary">Fava opens a pull request containing only the skill file. After it merges, refresh this library and choose where to use it.</p>
        <Input label="Skill name" value={skillName} onChange={setSkillName} placeholder="review-changes" maxLength={63} />
        <Textarea label="Skill instructions" value={skillContent} onChange={setSkillContent} rows={6} resize="vertical" maxLength={12000} hint="Write Markdown instructions, 20–12,000 bytes." />
        <Button size="small" disabled={busy || !skillName.trim() || !skillContent.trim()} onClick={() => void propose()}>{busy ? "Working…" : "Create skill pull request"}</Button>
        {proposal && <p role="status" className="text-body-regular text-text-secondary">Skill PR #{proposal.number} is ready for review. <a href={proposal.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-600 hover:underline">Open pull request <RiExternalLinkLine className="size-4" aria-hidden /></a></p>}
      </div>}
    </div>}
  </section>;
}
