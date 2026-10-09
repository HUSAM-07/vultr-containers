"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RiAddLine, RiArrowRightLine, RiBookOpenLine, RiExternalLinkLine, RiFileTextLine,
  RiFolder3Line, RiGitPullRequestLine, RiGithubFill, RiLogoutBoxLine, RiRefreshLine } from "@remixicon/react";
import { Button, ButtonLink } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Textarea } from "@/components/base/textarea/textarea";
import { CloudflarePreviewPanel } from "@/components/application/cloudflare-preview-panel";
import { ProjectMembersPanel } from "@/components/application/project-members-panel";
import { SkillsPanel } from "@/components/application/skills-panel";
import { WorkspaceAccountsPanel, type Workspace } from "@/components/application/workspace-accounts-panel";
import { agentModels } from "@/lib/fava-models";
import { cx } from "@/utils/cx";

type Session = { configured: boolean; connected: boolean; user: { login: string; avatarUrl: string } | null; installUrl: string | null };
type Repository = { id: number; fullName: string; private: boolean; defaultBranch: string; canPush: boolean; htmlUrl: string; installationId: number };
type Project = { id: string; accountId: string; accountName: string; repository: string; defaultBranch: string;
  role: "owner" | "admin" | "editor" | "viewer"; accountRole: "owner" | "admin" | "editor" | "viewer" | null };
type Context = { repository: string; defaultBranch: string; paths: string[]; truncated: boolean; files: { path: string; text: string }[] };
type Published = { url: string; number: number; branch: string; path: string };
type SpecProposal = { number: number; title: string; url: string; path: string; status: "open" | "merged" | "closed"; mergedCommitSha: string | null };
type AgentRun = { id: string; status: string; model: string; provider: string; mergedCommitSha: string;
  specPullNumber: number; specPath: string; pullNumber: number | null; previewUrl: string | null;
  summary: string | null; error: string | null; artifactKey: string | null };

const initialSpec = `## Outcome\n\nDescribe the result a user should experience.\n\n## Scope\n\nDescribe what must be built, and what is outside this change.\n\n## Acceptance criteria\n\n- Describe an observable behavior or test.\n`;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "Request failed");
  return value as T;
}

export default function WorkspacePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [accounts, setAccounts] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [repo, setRepo] = useState("");
  const [context, setContext] = useState<Context | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState(initialSpec);
  const [model, setModel] = useState<string>(agentModels[0].model);
  const [published, setPublished] = useState<Published | null>(null);
  const [specs, setSpecs] = useState<SpecProposal[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);
  const initialized = useRef(false);
  const choiceId = useRef(0);

  const choose = useCallback(async (name: string, existing?: Project) => {
    const requestId = ++choiceId.current;
    setRepo(name); setContext(null); setSpecs([]); setRuns([]); setPublished(null); setError(""); setBusy(true);
    try {
      const linked = existing || await json<Project>("/api/github?action=project", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: name, accountId: workspaceId }) });
      if (requestId !== choiceId.current) return;
      setWorkspaceId(linked.accountId);
      if (!existing) setProjects(current => [linked, ...current.filter(item => item.id !== linked.id)]);
      const selected = encodeURIComponent(name);
      const [imported, proposals, recentRuns] = await Promise.all([
        json<Context>(`/api/github?action=context&repo=${selected}`),
        json<SpecProposal[]>(`/api/github?action=specs&repo=${selected}`),
        json<AgentRun[]>(`/api/github?action=runs&repo=${selected}`),
      ]);
      if (requestId !== choiceId.current) return;
      setContext(imported); setSpecs(proposals); setRuns(recentRuns);
    }
    catch (cause) { if (requestId === choiceId.current) setError((cause as Error).message); }
    finally { if (requestId === choiceId.current) setBusy(false); }
  }, [workspaceId]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    let savedRepo = "";
    try {
      const draft = JSON.parse(localStorage.getItem("fava:draft") || "{}");
      if (typeof draft.repo === "string") savedRepo = draft.repo;
      queueMicrotask(() => {
        if (typeof draft.title === "string") setTitle(draft.title);
        if (typeof draft.content === "string") setContent(draft.content);
        if (savedRepo) setRepo(savedRepo);
        if (agentModels.some(item => item.model === draft.model)) setModel(draft.model);
        setRestored(true);
      });
    } catch { queueMicrotask(() => setRestored(true)); }
    json<Session>("/api/github").then(async value => {
      setSession(value);
      if (value.connected) {
        const [available, linked, workspaces] = await Promise.all([
          json<Repository[]>("/api/github?action=repos"), json<Project[]>("/api/github?action=projects"),
          json<Workspace[]>("/api/accounts")]);
        setRepos(available); setProjects(linked); setAccounts(workspaces);
        const prior = linked.find(project => project.repository === savedRepo);
        setWorkspaceId(prior?.accountId || workspaces[0]?.id || "");
        if (prior && available.some(item => item.fullName === savedRepo)) await choose(savedRepo, prior);
        else if (savedRepo) setRepo("");
      }
    }).catch(cause => setError((cause as Error).message));
  }, [choose]);
  useEffect(() => {
    if (!restored) return;
    try { localStorage.setItem("fava:draft", JSON.stringify({ repo, title, content, model })); } catch { /* Local drafts are optional. */ }
  }, [repo, title, content, model, restored]);

  useEffect(() => {
    if (!session?.connected || !repo || !projects.some(project => project.repository === repo)) return;
    let current = true;
    const timer = window.setInterval(() => {
      json<AgentRun[]>(`/api/github?action=runs&repo=${encodeURIComponent(repo)}`)
        .then(value => { if (current) setRuns(value); }).catch(() => {});
    }, 20_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [repo, session?.connected, projects]);

  function selectWorkspace(id: string) {
    choiceId.current += 1;
    setWorkspaceId(id); setRepo(""); setContext(null); setSpecs([]); setRuns([]);
    setPublished(null); setBusy(false); setError("");
  }

  async function publish() {
    if (!repo || !context || busy) return;
    setBusy(true); setError(""); setPublished(null);
    try {
      setPublished(await json<Published>("/api/github?action=spec", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo, title, content, model }) }));
      try { setSpecs(await json<SpecProposal[]>(`/api/github?action=specs&repo=${encodeURIComponent(repo)}`)); }
      catch { /* The pull request was created; a stale list should not report publication failure. */ }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function logout() {
    try { await json("/api/github?action=logout", { method: "POST" }); window.location.reload(); }
    catch (cause) { setError((cause as Error).message); }
  }

  const selectedProject = projects.find(project => project.repository === repo);

  return <main className="min-h-dvh bg-background-full p-3 text-text-primary sm:p-5">
    <div className="mx-auto grid min-h-[calc(100dvh-2.5rem)] max-w-[1600px] gap-4 lg:grid-cols-[280px_minmax(0,1fr)_320px]">
      <aside className="flex flex-col rounded-3xl border border-border-button-default bg-background-secondary-default p-4">
        <div className="flex items-center justify-between"><Link href="/" className="flex items-center gap-2 text-title-3-semibold"><span className="grid size-8 place-items-center rounded-xl bg-accent-600 text-background-primary-default">F</span>Fava</Link><span className="rounded-full bg-background-tertiary-default px-2 py-1 text-caption-1-semibold text-text-tertiary">Workspace</span></div>
        {session?.connected && <WorkspaceAccountsPanel accounts={accounts} selectedId={workspaceId}
          onSelect={selectWorkspace}
          onCreated={account => { setAccounts(current => [...current, account]); selectWorkspace(account.id); }} />}
        <div className="mt-8 flex items-center justify-between"><h2 className="text-caption-1-semibold uppercase tracking-widest text-text-tertiary">Repositories</h2>{session?.connected && <Button variant="ghost" size="xs" iconOnly leadingIcon={RiRefreshLine} aria-label="Refresh repositories" onClick={() => json<Repository[]>("/api/github?action=repos").then(setRepos).catch(cause => setError((cause as Error).message))} />}</div>
        {session?.connected ? <div className="mt-3 flex flex-col gap-1">{repos.length ? repos.map(item => {
          const linked = projects.find(project => project.repository === item.fullName);
          const current = accounts.find(account => account.id === workspaceId);
          return <Button key={item.id} variant="ghost" disabled={!linked && current?.role !== "owner" && current?.role !== "admin"}
            onClick={() => void choose(item.fullName, linked)} className={cx("!h-auto !min-h-9 !justify-start !whitespace-normal !text-start", repo === item.fullName && "!bg-background-tertiary-default")} leadingIcon={RiFolder3Line}>
            {item.fullName}{linked ? ` · ${linked.accountName}` : ""}</Button>;
        }) : <p className="rounded-xl border border-border-button-default p-3 text-body-regular text-text-secondary">No repositories are available to this GitHub App yet.</p>}</div> : <div className="mt-3 rounded-xl border border-dashed border-border-button-default p-4 text-body-regular text-text-secondary">Your repositories appear here after you connect GitHub.</div>}
        {session?.connected && <div className="mt-4 flex flex-wrap gap-2">{session.installUrl && <ButtonLink href={session.installUrl} target="_blank" rel="noreferrer" variant="secondary" size="small" leadingIcon={RiAddLine}>Install on repos</ButtonLink>}<ButtonLink href="https://github.com/new" target="_blank" rel="noreferrer" variant="ghost" size="small">New on GitHub</ButtonLink></div>}
        <div className="mt-auto border-t border-separator-border pt-5">{session?.connected ? <div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-full bg-background-tertiary-default text-body-medium">{session.user?.login.slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1 truncate text-body-medium">{session.user?.login}</span><Button variant="ghost" size="xs" iconOnly leadingIcon={RiLogoutBoxLine} aria-label="Disconnect GitHub" onClick={() => void logout()} /></div> : <p className="text-caption-1-regular text-text-tertiary">Your draft stays in this browser until it is published to GitHub.</p>}</div>
      </aside>

      <section className="min-w-0 rounded-3xl border border-border-button-default bg-background-secondary-default p-5 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-caption-1-semibold uppercase tracking-widest text-accent-600">Specification editor</p><h1 className="mt-2 text-title-1-medium">Start with intent</h1><p className="mt-2 max-w-2xl text-body-regular text-text-secondary">A merged spec becomes the contract for implementation. Describe the result clearly before asking an agent to write code.</p></div><span className="inline-flex items-center gap-2 rounded-full bg-background-tertiary-default px-3 py-2 text-caption-1-semibold text-text-secondary"><RiBookOpenLine className="size-4" aria-hidden />{session?.connected && repo ? repo : "No repository selected"}</span></div>
        {!session?.connected && <div className="mt-7 rounded-2xl border border-border-button-default bg-background-primary-default p-5"><div className="flex items-center gap-3"><RiGithubFill className="size-6" aria-hidden /><div><h2 className="text-body-medium">Connect GitHub to publish specs</h2><p className="text-body-regular text-text-secondary">You can write a draft now. Connect an account when you are ready to save it as a pull request.</p></div></div><div className="mt-4">{session?.configured ? <ButtonLink href="/api/github/auth/start" leadingIcon={RiGithubFill}>Continue with GitHub</ButtonLink> : <p className="text-body-regular text-text-secondary">The Fava GitHub App has not been configured for this deployment yet.</p>}</div></div>}
        {session?.connected && !repo && <div className="mt-7 rounded-2xl border border-dashed border-border-button-default bg-background-primary-default p-5"><h2 className="text-body-medium">Choose a repository to import</h2><p className="mt-2 text-body-regular text-text-secondary">Fava will read its file map and project instructions. The code stays in GitHub.</p></div>}
        <div className="mt-8 grid gap-6"><Input label="Specification title" placeholder="What should change?" value={title} onChange={setTitle} maxLength={120} /><Textarea label="Specification" value={content} onChange={setContent} rows={16} resize="vertical" maxLength={40000} hint="Include the outcome, scope, and acceptance criteria. Your draft is saved in this browser." /></div>
        <div className="mt-6"><p className="text-body-medium">Implementation agent</p><p className="mt-1 text-body-regular text-text-secondary">Fava records this choice with the spec PR. Work is queued only after the spec merges.</p><div role="group" aria-label="Implementation agent" className="mt-3 flex flex-wrap gap-2">{agentModels.map(option => <Button key={option.model} variant={model === option.model ? "primary" : "secondary"} size="small" aria-pressed={model === option.model} onClick={() => setModel(option.model)}>{option.label}</Button>)}</div></div>
        {error && <p role="alert" className="mt-5 rounded-xl border border-border-error-default p-3 text-body-regular text-text-error-primary">{error}</p>}
        {published && <div role="status" className="mt-5 rounded-xl border border-border-button-default bg-background-primary-default p-4"><p className="text-body-medium">Specification PR #{published.number} is ready for review.</p><p className="mt-1 text-body-regular text-text-secondary">Agent implementation waits until this spec is merged.</p><a className="mt-3 inline-flex items-center gap-2 text-body-medium text-accent-600 hover:underline" href={published.url} target="_blank" rel="noreferrer">Open pull request <RiExternalLinkLine className="size-4" aria-hidden /></a></div>}
        <div className="mt-6 flex flex-wrap items-center gap-3"><Button onClick={() => void publish()} disabled={!session?.connected || !context || !selectedProject || selectedProject.role === "viewer" || busy} leadingIcon={RiGitPullRequestLine}>{busy ? "Working…" : "Create spec pull request"}</Button><span className="text-caption-1-regular text-text-tertiary">Requires editor access to this project and write access to its repository.</span></div>
      </section>

      <aside className="min-w-0 rounded-3xl border border-border-button-default bg-background-secondary-default p-5"><div className="flex items-center gap-2"><RiFileTextLine className="size-5 text-accent-600" aria-hidden /><h2 className="text-title-3-semibold">Imported context</h2></div>{context ? <><p className="mt-3 text-body-regular text-text-secondary">{context.repository} · {context.defaultBranch}</p><div className="mt-5 max-h-56 overflow-auto rounded-xl border border-border-button-default bg-background-primary-default p-3"><p className="text-caption-1-semibold uppercase tracking-widest text-text-tertiary">File map</p><ul className="mt-3 space-y-1">{context.paths.map(path => <li key={path} className="truncate font-mono text-caption-1-regular text-text-secondary" title={path}>{path}</li>)}</ul>{context.truncated && <p className="mt-2 text-caption-1-regular text-text-tertiary">Showing the first 400 paths.</p>}</div><div className="mt-5 space-y-3">{context.files.map(file => <details key={file.path} className="rounded-xl border border-border-button-default bg-background-primary-default p-3"><summary className="cursor-pointer text-body-medium">{file.path}</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-caption-1-regular text-text-secondary">{file.text}</pre></details>)}</div><div className="mt-6 border-t border-separator-border pt-5"><div className="flex items-center justify-between gap-2"><h3 className="text-body-medium">Recent spec proposals</h3><Button variant="ghost" size="xs" iconOnly leadingIcon={RiRefreshLine} aria-label="Refresh spec proposals" onClick={() => json<SpecProposal[]>(`/api/github?action=specs&repo=${encodeURIComponent(repo)}`).then(setSpecs).catch(cause => setError((cause as Error).message))} /></div>{specs.length ? <ul className="mt-3 space-y-2">{specs.map(spec => <li key={spec.number} className="rounded-xl border border-border-button-default bg-background-primary-default p-3"><a href={spec.url} target="_blank" rel="noreferrer" className="text-body-medium text-accent-600 hover:underline">#{spec.number} {spec.title}</a><p className="mt-1 text-caption-1-regular text-text-secondary">{spec.status === "merged" ? "Merged · implementation pending" : spec.status === "open" ? "Awaiting merge" : "Closed without merge"}</p></li>)}</ul> : <p className="mt-2 text-body-regular text-text-secondary">No recent spec-only pull requests found.</p>}</div></> : <div className="mt-5 rounded-2xl border border-dashed border-border-button-default p-5 text-center"><RiFolder3Line className="mx-auto size-7 text-foreground-icon-tertiary" aria-hidden /><p className="mt-3 text-body-medium">No context imported yet</p><p className="mt-2 text-body-regular text-text-secondary">Choose a connected repository to inspect its structure and instructions.</p></div>}
        {context && <div className="mt-6 border-t border-separator-border pt-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-body-medium">Implementation runs</h3>
            <Button variant="ghost" size="xs" iconOnly leadingIcon={RiRefreshLine} aria-label="Refresh implementation runs" onClick={() => json<AgentRun[]>(`/api/github?action=runs&repo=${encodeURIComponent(repo)}`).then(setRuns).catch(cause => setError((cause as Error).message))} />
          </div>
          {runs.length ? <ul className="mt-3 space-y-2">{runs.map(run =>
            <li key={run.id} className="rounded-xl border border-border-button-default bg-background-primary-default p-3">
              <p className="text-body-medium">Spec #{run.specPullNumber} · {run.status === "succeeded" ? run.pullNumber ? "Agent completed · draft PR" : "Agent completed · PR pending" : run.status}</p>
              <p className="mt-1 text-caption-1-regular text-text-secondary">{run.model} · {run.mergedCommitSha.slice(0, 7)}</p>
              {run.pullNumber && <a href={`https://github.com/${repo}/pull/${run.pullNumber}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-body-medium text-accent-600 hover:underline">Implementation PR #{run.pullNumber} <RiExternalLinkLine className="size-4" aria-hidden /></a>}
              {run.summary && <p className="mt-2 text-body-regular text-text-secondary">{run.summary}</p>}
              {run.error && <p className="mt-2 text-body-regular text-text-error-primary">{run.error}</p>}
              {run.artifactKey && <div className="mt-2 flex flex-wrap gap-3">
                {(run.status === "succeeded" || run.error?.startsWith("Spec review rejected") ? ["diff", "review", "stdout", "stderr"] : ["stdout", "stderr"]).map(kind =>
                  <a key={kind} href={`/api/github/runs/${run.id}/artifact?kind=${kind}`} target="_blank" rel="noreferrer" className="text-body-medium text-accent-600 hover:underline">{kind === "diff" ? "Code diff" : kind === "review" ? "Spec review" : kind === "stdout" ? run.status === "running" ? "Agent log (live)" : "Agent log" : "Error log"}</a>)}
              </div>}
              {run.previewUrl?.startsWith("https://") && <a href={run.previewUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-body-medium text-accent-600 hover:underline">Preview <RiExternalLinkLine className="size-4" aria-hidden /></a>}
            </li>)}</ul> : <p className="mt-2 text-body-regular text-text-secondary">No implementation run has been queued for this project.</p>}
        </div>}
        {session?.connected && repo && selectedProject && <>
          <SkillsPanel key={`skills-${repo}`} repository={repo} canEdit={selectedProject.role !== "viewer"}
            canManageWorkspace={selectedProject.accountRole === "owner" || selectedProject.accountRole === "admin"} />
          {(selectedProject.role === "owner" || selectedProject.role === "admin") &&
            <ProjectMembersPanel key={`members-${repo}`} repository={repo} />}
          <CloudflarePreviewPanel key={`preview-${repo}`} repository={repo} />
        </>}
        <div className="mt-6 border-t border-separator-border pt-5"><a href="/demo" className="inline-flex items-center gap-2 text-body-medium text-text-secondary hover:text-text-primary">View the current agent demo <RiArrowRightLine className="size-4" aria-hidden /></a></div></aside>
    </div>
  </main>;
}
