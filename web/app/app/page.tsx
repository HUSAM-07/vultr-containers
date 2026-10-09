"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RiAddLine, RiArrowRightLine, RiBookOpenLine, RiExternalLinkLine, RiFileTextLine,
  RiFolder3Line, RiGitPullRequestLine, RiGithubFill, RiLogoutBoxLine, RiRefreshLine } from "@remixicon/react";
import { Button, ButtonLink } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Textarea } from "@/components/base/textarea/textarea";
import { cx } from "@/utils/cx";

type Session = { configured: boolean; connected: boolean; user: { login: string; avatarUrl: string } | null; installUrl: string | null };
type Repository = { id: number; fullName: string; private: boolean; defaultBranch: string; canPush: boolean; htmlUrl: string };
type Context = { repository: string; defaultBranch: string; paths: string[]; truncated: boolean; files: { path: string; text: string }[] };
type Published = { url: string; number: number; branch: string; path: string };

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
  const [repo, setRepo] = useState("");
  const [context, setContext] = useState<Context | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState(initialSpec);
  const [published, setPublished] = useState<Published | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const draft = JSON.parse(localStorage.getItem("fava:draft") || "{}");
      queueMicrotask(() => {
        if (typeof draft.title === "string") setTitle(draft.title);
        if (typeof draft.content === "string") setContent(draft.content);
        if (typeof draft.repo === "string") setRepo(draft.repo);
        setRestored(true);
      });
    } catch { queueMicrotask(() => setRestored(true)); }
    json<Session>("/api/github").then(async value => {
      setSession(value);
      if (value.connected) setRepos(await json<Repository[]>("/api/github?action=repos"));
    }).catch(cause => setError((cause as Error).message));
  }, []);
  useEffect(() => {
    if (!restored) return;
    try { localStorage.setItem("fava:draft", JSON.stringify({ repo, title, content })); } catch { /* Local drafts are optional. */ }
  }, [repo, title, content, restored]);

  async function choose(name: string) {
    setRepo(name); setContext(null); setPublished(null); setError(""); setBusy(true);
    try { setContext(await json<Context>(`/api/github?action=context&repo=${encodeURIComponent(name)}`)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function publish() {
    if (!repo || busy) return;
    setBusy(true); setError(""); setPublished(null);
    try {
      setPublished(await json<Published>("/api/github?action=spec", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo, title, content }) }));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function logout() {
    try { await json("/api/github?action=logout", { method: "POST" }); window.location.reload(); }
    catch (cause) { setError((cause as Error).message); }
  }

  return <main className="min-h-dvh bg-background-full p-3 text-text-primary sm:p-5">
    <div className="mx-auto grid min-h-[calc(100dvh-2.5rem)] max-w-[1600px] gap-4 lg:grid-cols-[280px_minmax(0,1fr)_320px]">
      <aside className="flex flex-col rounded-3xl border border-border-button-default bg-background-secondary-default p-4">
        <div className="flex items-center justify-between"><Link href="/" className="flex items-center gap-2 text-title-3-semibold"><span className="grid size-8 place-items-center rounded-xl bg-accent-600 text-background-primary-default">F</span>Fava</Link><span className="rounded-full bg-background-tertiary-default px-2 py-1 text-caption-1-semibold text-text-tertiary">Workspace</span></div>
        <div className="mt-8 flex items-center justify-between"><h2 className="text-caption-1-semibold uppercase tracking-widest text-text-tertiary">Repositories</h2>{session?.connected && <Button variant="ghost" size="xs" iconOnly leadingIcon={RiRefreshLine} aria-label="Refresh repositories" onClick={() => json<Repository[]>("/api/github?action=repos").then(setRepos).catch(cause => setError((cause as Error).message))} />}</div>
        {session?.connected ? <div className="mt-3 flex flex-col gap-1">{repos.length ? repos.map(item => <Button key={item.id} variant="ghost" onClick={() => void choose(item.fullName)} className={cx("!h-auto !min-h-9 !justify-start !whitespace-normal !text-start", repo === item.fullName && "!bg-background-tertiary-default")} leadingIcon={RiFolder3Line}>{item.fullName}</Button>) : <p className="rounded-xl border border-border-button-default p-3 text-body-regular text-text-secondary">No repositories are available to this GitHub App yet.</p>}</div> : <div className="mt-3 rounded-xl border border-dashed border-border-button-default p-4 text-body-regular text-text-secondary">Your repositories appear here after you connect GitHub.</div>}
        {session?.connected && <div className="mt-4 flex flex-wrap gap-2">{session.installUrl && <ButtonLink href={session.installUrl} target="_blank" rel="noreferrer" variant="secondary" size="small" leadingIcon={RiAddLine}>Install on repos</ButtonLink>}<ButtonLink href="https://github.com/new" target="_blank" rel="noreferrer" variant="ghost" size="small">New on GitHub</ButtonLink></div>}
        <div className="mt-auto border-t border-separator-border pt-5">{session?.connected ? <div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-full bg-background-tertiary-default text-body-medium">{session.user?.login.slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1 truncate text-body-medium">{session.user?.login}</span><Button variant="ghost" size="xs" iconOnly leadingIcon={RiLogoutBoxLine} aria-label="Disconnect GitHub" onClick={() => void logout()} /></div> : <p className="text-caption-1-regular text-text-tertiary">Your draft stays in this browser until it is published to GitHub.</p>}</div>
      </aside>

      <section className="min-w-0 rounded-3xl border border-border-button-default bg-background-secondary-default p-5 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-caption-1-semibold uppercase tracking-widest text-accent-600">Specification editor</p><h1 className="mt-2 text-title-1-medium">Start with intent</h1><p className="mt-2 max-w-2xl text-body-regular text-text-secondary">A merged spec becomes the contract for implementation. Describe the result clearly before asking an agent to write code.</p></div><span className="inline-flex items-center gap-2 rounded-full bg-background-tertiary-default px-3 py-2 text-caption-1-semibold text-text-secondary"><RiBookOpenLine className="size-4" aria-hidden />{repo || "No repository selected"}</span></div>
        {!session?.connected && <div className="mt-7 rounded-2xl border border-border-button-default bg-background-primary-default p-5"><div className="flex items-center gap-3"><RiGithubFill className="size-6" aria-hidden /><div><h2 className="text-body-medium">Connect GitHub to publish specs</h2><p className="text-body-regular text-text-secondary">You can write a draft now. Connect an account when you are ready to save it as a pull request.</p></div></div><div className="mt-4">{session?.configured ? <ButtonLink href="/api/github/auth/start" leadingIcon={RiGithubFill}>Continue with GitHub</ButtonLink> : <p className="text-body-regular text-text-secondary">The Fava GitHub App has not been configured for this deployment yet.</p>}</div></div>}
        {session?.connected && !repo && <div className="mt-7 rounded-2xl border border-dashed border-border-button-default bg-background-primary-default p-5"><h2 className="text-body-medium">Choose a repository to import</h2><p className="mt-2 text-body-regular text-text-secondary">Fava will read its file map and project instructions. The code stays in GitHub.</p></div>}
        <div className="mt-8 grid gap-6"><Input label="Specification title" placeholder="What should change?" value={title} onChange={setTitle} maxLength={120} /><Textarea label="Specification" value={content} onChange={setContent} rows={16} resize="vertical" maxLength={40000} hint="Include the outcome, scope, and acceptance criteria. Your draft is saved in this browser." /></div>
        {error && <p role="alert" className="mt-5 rounded-xl border border-border-error-default p-3 text-body-regular text-text-error-primary">{error}</p>}
        {published && <div role="status" className="mt-5 rounded-xl border border-border-button-default bg-background-primary-default p-4"><p className="text-body-medium">Specification PR #{published.number} is ready for review.</p><p className="mt-1 text-body-regular text-text-secondary">Agent implementation waits until this spec is merged.</p><a className="mt-3 inline-flex items-center gap-2 text-body-medium text-accent-600 hover:underline" href={published.url} target="_blank" rel="noreferrer">Open pull request <RiExternalLinkLine className="size-4" aria-hidden /></a></div>}
        <div className="mt-6 flex flex-wrap items-center gap-3"><Button onClick={() => void publish()} disabled={!session?.connected || !repo || busy} leadingIcon={RiGitPullRequestLine}>{busy ? "Working…" : "Create spec pull request"}</Button><span className="text-caption-1-regular text-text-tertiary">Requires write access to the selected repository.</span></div>
      </section>

      <aside className="min-w-0 rounded-3xl border border-border-button-default bg-background-secondary-default p-5"><div className="flex items-center gap-2"><RiFileTextLine className="size-5 text-accent-600" aria-hidden /><h2 className="text-title-3-semibold">Imported context</h2></div>{context ? <><p className="mt-3 text-body-regular text-text-secondary">{context.repository} · {context.defaultBranch}</p><div className="mt-5 max-h-56 overflow-auto rounded-xl border border-border-button-default bg-background-primary-default p-3"><p className="text-caption-1-semibold uppercase tracking-widest text-text-tertiary">File map</p><ul className="mt-3 space-y-1">{context.paths.map(path => <li key={path} className="truncate font-mono text-caption-1-regular text-text-secondary" title={path}>{path}</li>)}</ul>{context.truncated && <p className="mt-2 text-caption-1-regular text-text-tertiary">Showing the first 400 paths.</p>}</div><div className="mt-5 space-y-3">{context.files.map(file => <details key={file.path} className="rounded-xl border border-border-button-default bg-background-primary-default p-3"><summary className="cursor-pointer text-body-medium">{file.path}</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-caption-1-regular text-text-secondary">{file.text}</pre></details>)}</div></> : <div className="mt-5 rounded-2xl border border-dashed border-border-button-default p-5 text-center"><RiFolder3Line className="mx-auto size-7 text-foreground-icon-tertiary" aria-hidden /><p className="mt-3 text-body-medium">No context imported yet</p><p className="mt-2 text-body-regular text-text-secondary">Choose a connected repository to inspect its structure and instructions.</p></div>}<div className="mt-6 border-t border-separator-border pt-5"><a href="/demo" className="inline-flex items-center gap-2 text-body-medium text-text-secondary hover:text-text-primary">View the current agent demo <RiArrowRightLine className="size-4" aria-hidden /></a></div></aside>
    </div>
  </main>;
}
