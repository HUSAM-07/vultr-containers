"use client";

import { useCallback, useEffect, useState } from "react";
import {
  RiAddLine, RiArrowDownSLine, RiArrowGoBackLine, RiArrowRightSLine, RiArrowUpLine, RiCodeLine,
  RiFileCopyLine, RiFolder3Line, RiFolderOpenLine, RiGitBranchLine, RiGlobalLine,
  RiHeadphoneLine, RiInfinityLine, RiLayoutRightLine, RiMenuLine, RiMicLine, RiMoonLine,
  RiMoreLine, RiReactjsLine, RiRobot2Line, RiSearchLine, RiSettings3Line, RiUpload2Line,
  RiShieldCheckLine, RiSunLine, RiTerminalLine, RiExpandDiagonalLine,
  RiThumbDownLine, RiThumbUpLine, RiExpandUpDownLine,
} from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Textarea } from "@/components/base/textarea/textarea";
import { AgentThinking } from "@/components/application/agent-thinking/agent-thinking";
import { AgentSteps, type Step } from "@/components/spectrum/agent-steps";
import { cx } from "@/utils/cx";

type Run = {
  id: string; task: string; project: string; mode: "build" | "containment";
  status: "queued" | "running" | "succeeded" | "failed";
  plan: string[]; steps: Step[]; createdAt: number; summary?: string; error?: string;
  code?: string; artifact?: string;
  output?: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
};
const homeProject = "vibl coding project";
const starterProjects = ["boardui", homeProject, "strider landing page work", "pirate mini game iOS"];
const examples = [
  { name: "landing page design", time: "34m" }, { name: "image generation", time: "now" },
  { name: "coding scenario", time: "now" }, { name: "mobile app for yueis...", time: "5h" },
  { name: "code refactor dropd...", time: "18h" },
];
const examplePrompt = "update our color tokens for dark mode and add a reusable theme toggle to the registry. run lint and a production build when you're done.";
const exampleReply = "Done — the semantic dark-mode tokens and reusable theme toggle are wired. The toggle updates the root theme from one place and persists the selection:";
const exampleCode = `const nextTheme = theme === "dark" ? "light" : "dark";

document.documentElement.classList.toggle(
  "dark",
  nextTheme === "dark",
);
localStorage.setItem("boardui:theme", nextTheme);`;
const exampleSideCode = `import type { Metadata } from "next";
import Link from "next/link";
import { ComponentDetail } from "@/components/application/docs/component-detail";
import { DashboardShell } from "@/components/application/dashboard/dashboard-shell";

export const metadata: Metadata = {
  title: "Home Dashboard Template — React + Tailwind (Pro)",
  description:
    "Full admin dashboard template for React + Tailwind CSS — sidebar navigation, KPI cards, bar chart, and a customers data table. A BoardUI Pro template.",
};

const PREVIEW_CODE = \`import { DashboardShell } from "@/components/application/dashboard/dashboard-shell";\`;

export default function DashboardPage() {
  // Full screen: floating sidebar, header, KPI cards,
  // earnings bar chart, and the customers data table.
  return <DashboardShell />;
};

export default function HomeDashboardDetail() {
  return (
    <ComponentDetail
      title="Home Dashboard"
      preview={<DashboardShell />}
    />
  );
}`;
const suggestions = ["Build a static pricing page for three plans and verify the prices.", "Create a cohort retention analysis with sample data.", "Validate a CSV product import with malformed rows."];
const subtleIcon = "!bg-transparent !text-foreground-icon-secondary hover:!bg-background-tertiary-default";

function CodeLines({ code, limit = 120, compact = false }: { code: string; limit?: number; compact?: boolean }) {
  return <div className={cx("min-w-0 overflow-auto font-mono", compact ? "text-caption-1-regular leading-[18px]" : "text-body-2-regular leading-[23px]")}>
    {code.split("\n").slice(0, limit).map((line, index) => <div key={index} className={cx("flex", compact ? "min-h-[18px]" : "min-h-[23px]")}>
      <span className="w-9 shrink-0 select-none pe-3 text-end text-text-tertiary">{index + 1}</span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-words text-text-secondary">{line.split(/(\x60[^\x60]*\x60|"[^\"]*"|'[^']*'|===|\b(?:import|from|export|const|return|function|type|let|if|else|default|Link|Metadata|ComponentDetail|DashboardShell|PREVIEW_CODE|nextTheme)\b)/g).map((part, i) => <span key={i} className={/^(import|from|export|const|return|function|type|let|if|else|default|Link|===)$/.test(part) ? "text-chart-2-active" : /^(Metadata|ComponentDetail|DashboardShell|nextTheme)$/.test(part) ? "text-chart-7-active" : part === "PREVIEW_CODE" ? "text-accent-500" : /^[\x60'"]/.test(part) ? "text-text-tertiary" : ""}>{part}</span>)}</code>
    </div>)}
  </div>;
}

export default function Home() {
  const [projects, setProjects] = useState(starterProjects);
  const [restored, setRestored] = useState(false);
  const [project, setProject] = useState(homeProject);
  const [newProject, setNewProject] = useState("");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<Run | null>(null);
  const [example, setExample] = useState("coding scenario");
  const [task, setTask] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [provider, setProvider] = useState("Vultr Serverless Inference");
  const [panel, setPanel] = useState<"changes" | "browser" | "logs">("changes");
  const [expanded, setExpanded] = useState(false);
  const [dark, setDark] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [inspectorHidden, setInspectorHidden] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("forge:projects") || "[]");
      if (Array.isArray(saved) && saved.every(item => typeof item === "string"))
        // eslint-disable-next-line react-hooks/set-state-in-effect -- restore browser state after hydration
        setProjects([...starterProjects, ...saved.filter(item => !starterProjects.includes(item))]);
      const isDark = localStorage.getItem("forge:dark") === "true";
      setDark(isDark);
      document.documentElement.classList.toggle("dark", isDark);
    } catch { /* optional browser storage */ }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (restored) try { localStorage.setItem("forge:projects", JSON.stringify(projects)); } catch { /* optional */ }
  }, [projects, restored]);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/backend/runs", { cache: "no-store" });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || "Unable to load runs");
      const list = value as Run[];
      setRuns(list);
      setProjects(current => {
        const missing = list.map(run => run.project).filter(name => !current.includes(name));
        return missing.length ? [...current, ...new Set(missing)] : current;
      });
    } catch (cause) { setError((cause as Error).message); }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh updates state after HTTP response
    void refresh();
    fetch("/api/backend/health").then(response => response.json()).then(value => {
      setConfigured(Boolean(value.configured));
      if (typeof value.provider === "string") setProvider(value.provider);
    }).catch(() => setConfigured(false));
  }, [refresh]);
  const hasActive = runs.some(run => run.status === "running" || run.status === "queued");
  useEffect(() => { if (hasActive) { const timer = setInterval(refresh, 3000); return () => clearInterval(timer); } }, [hasActive, refresh]);
  const poll = selected?.id !== selectedId || selected?.status === "running" || selected?.status === "queued";
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const load = async () => {
      try { const response = await fetch("/api/backend/runs/" + selectedId, { cache: "no-store" }); if (response.ok && !cancelled) setSelected(await response.json()); }
      catch { /* next poll retries */ }
    };
    void load();
    if (!poll) return () => { cancelled = true; };
    const timer = setInterval(load, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selectedId, poll]);

  async function submit(mode: "build" | "containment" = "build") {
    if (pending || (!task.trim() && mode === "build")) return;
    setPending(true); setError("");
    try {
      const response = await fetch("/api/backend/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, task: mode === "containment" ? "Demonstrate sandbox time limit" : task.trim(), mode }) });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || "Run could not start");
      setSelected(value); setSelectedId(value.id); setExample(""); setTask(""); void refresh();
    } catch (cause) { setError((cause as Error).message); } finally { setPending(false); }
  }
  function addProject() {
    const name = newProject.trim(); if (!name || name.length > 80) return;
    setProjects(current => current.includes(name) ? current : [...current, name]);
    setProject(name); setNewProject(""); setAdding(false); setSelectedId(""); setSelected(null); setExample("");
  }
  function newAgent() { setSelectedId(""); setSelected(null); setExample(""); setTask(""); setSidebarOpen(false); }
  function pickProject(name: string) { setProject(name); setSelectedId(""); setSelected(null); setExample(name === homeProject ? "coding scenario" : ""); setSidebarOpen(false); }
  function toggleTheme(value: boolean) { setDark(value); document.documentElement.classList.toggle("dark", value); try { localStorage.setItem("forge:dark", String(value)); } catch { /* optional */ } }
  function openSidebar() { if (window.innerWidth < 1024) setSidebarOpen(true); else setSidebarHidden(false); }
  function closeSidebar() { if (window.innerWidth < 1024) setSidebarOpen(false); else setSidebarHidden(true); }
  function openInspector() { if (window.innerWidth < 1024) setInspectorOpen(true); else setInspectorHidden(false); }
  function closeInspector() { if (window.innerWidth < 1024) setInspectorOpen(false); else setInspectorHidden(true); setExpanded(false); }

  const current = selected?.project === project ? selected : null;
  const showExample = !selectedId && project === homeProject && Boolean(example);
  const projectRuns = runs.filter(run => run.project === project);
  const query = search.toLowerCase().trim();
  const additions = current?.code?.split("\n").length || 0;
  return <main className={cx("forge-reference grid h-dvh min-h-[620px] gap-x-4 overflow-hidden bg-background-full p-2 text-text-primary max-lg:grid-cols-1 max-sm:min-h-dvh max-sm:p-0", sidebarHidden && inspectorHidden ? "grid-cols-1" : sidebarHidden ? "grid-cols-[minmax(0,1fr)_424px] max-xl:grid-cols-[minmax(0,1fr)_360px]" : inspectorHidden ? "grid-cols-[261px_minmax(0,1fr)] max-xl:grid-cols-[244px_minmax(0,1fr)]" : "grid-cols-[261px_minmax(0,1fr)_424px] max-xl:grid-cols-[244px_minmax(0,1fr)_360px]")}>
    <aside className={cx("flex min-h-0 flex-col rounded-3xl border border-border-button-default bg-background-secondary-default px-3 py-3 shadow-sidebar max-lg:fixed max-lg:inset-y-2 max-lg:left-2 max-lg:z-30 max-lg:w-64", sidebarHidden && "lg:hidden", sidebarOpen ? "max-lg:flex" : "max-lg:hidden")}>
      <div className="flex h-10 items-center gap-2 px-1"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-background-tertiary-default text-body-medium text-text-secondary">M</span><span className="min-w-0 truncate text-body-medium">Mertcan Esmergul</span><RiExpandUpDownLine className="size-4 text-foreground-icon-tertiary" aria-hidden /><Button variant="ghost" size="xs" iconOnly leadingIcon={RiLayoutRightLine} aria-label="Close sidebar" className={cx(subtleIcon, "ms-auto")} onClick={closeSidebar} /></div>
      <div className="relative mt-[7px] px-0.5"><Input aria-label="Quick Search" placeholder="Quick Search" value={search} onChange={setSearch} leadingIcon={RiSearchLine} size="medium" fieldClassName="!rounded-full !bg-background-secondary-hover !border-0 !pe-12 !shadow-none" /><kbd aria-hidden="true" className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 rounded bg-background-secondary-default px-1 text-caption-1-regular text-text-tertiary">⌘L</kbd></div>
      <nav className="mt-3 flex flex-col gap-1" aria-label="Workspace">
        <button type="button" onClick={newAgent} className="flex h-9 items-center gap-3 rounded-lg px-2 text-body-regular text-text-secondary hover:bg-background-secondary-hover"><RiAddLine className="size-[18px]" aria-hidden />New agent</button>
        <button type="button" disabled title="Automations are not available in this preview" className="flex h-9 items-center gap-3 rounded-lg px-2 text-body-regular text-text-secondary"><RiRobot2Line className="size-[18px]" aria-hidden />Automations</button>
        <button type="button" onClick={() => toggleTheme(!dark)} className="flex h-9 items-center gap-3 rounded-lg px-2 text-body-regular text-text-secondary hover:bg-background-secondary-hover"><RiGitBranchLine className="size-[18px]" aria-hidden />Customize</button>
      </nav>
      <div className="mt-6 flex items-center justify-between px-1 text-body-regular text-text-secondary"><span>Repositories</span><Button variant="ghost" size="xs" iconOnly leadingIcon={RiAddLine} aria-label="Add repository" className={subtleIcon} onClick={() => setAdding(value => !value)} /></div>
      {adding && <form className="mt-2 flex gap-1" onSubmit={event => { event.preventDefault(); addProject(); }}><Input aria-label="Repository name" placeholder="Repository name" value={newProject} onChange={setNewProject} maxLength={80} size="small" /><Button type="submit" size="small" iconOnly leadingIcon={RiArrowUpLine} aria-label="Save repository" /></form>}
      <nav className="mt-[5px] flex min-h-0 flex-1 flex-col overflow-y-auto" aria-label="Repositories">
        {projects.filter(name => !query || name.toLowerCase().includes(query) || (name === homeProject && examples.some(thread => thread.name.includes(query))) || runs.some(run => run.project === name && run.task.toLowerCase().includes(query))).map(name => <div key={name}>
          <button type="button" onClick={() => pickProject(name)} className={cx("flex h-10 w-full items-center gap-2 rounded-lg px-2 text-start text-body-regular text-text-secondary hover:bg-background-secondary-hover", project === name && "text-text-primary")}>{project === name ? <RiFolderOpenLine className="size-[18px] shrink-0" aria-hidden /> : <RiFolder3Line className="size-[18px] shrink-0" aria-hidden />}<span className="truncate">{name}</span></button>
          {project === name && <div className="ms-4 border-s border-separator-border ps-1">
            {name === homeProject && examples.filter(thread => !query || thread.name.includes(query)).map(thread => <button key={thread.name} type="button" onClick={() => { setSelectedId(""); setSelected(null); setExample(thread.name); setSidebarOpen(false); }} className={cx("-ms-5 flex h-8 w-[calc(100%+1rem)] items-center gap-2 rounded-lg pe-2 ps-9 text-start text-body-regular text-text-secondary hover:bg-background-secondary-hover", example === thread.name && !selectedId && "bg-background-tertiary-default")}><span className="min-w-0 flex-1 truncate">{thread.name}</span><span className="rounded bg-background-tertiary-default px-1 text-caption-1-regular text-text-tertiary">{thread.time}</span></button>)}
            {projectRuns.filter(run => !query || run.task.toLowerCase().includes(query)).map(run => <button key={run.id} type="button" onClick={() => { setSelectedId(run.id); setSelected(null); setExample(""); setSidebarOpen(false); }} className={cx("-ms-5 flex h-8 w-[calc(100%+1rem)] items-center gap-2 rounded-lg pe-2 ps-9 text-start text-body-regular text-text-secondary hover:bg-background-secondary-hover", selectedId === run.id && "bg-background-tertiary-default")}><span className="min-w-0 flex-1 truncate">{run.task}</span><span className="text-caption-1-regular text-text-tertiary">{run.status === "running" ? "now" : "run"}</span></button>)}
          </div>}
        </div>)}
      </nav>
      <div className="mt-3 flex flex-col gap-1"><div className="mb-2 flex w-fit items-center gap-1 rounded-full bg-background-tertiary-default p-1"><Button variant="ghost" size="xs" iconOnly leadingIcon={RiSunLine} aria-label="Light theme" aria-pressed={!dark} onClick={() => toggleTheme(false)} className={cx(subtleIcon, "!rounded-full", !dark && "!bg-background-primary-default !shadow-xs")} /><Button variant="ghost" size="xs" iconOnly leadingIcon={RiMoonLine} aria-label="Dark theme" aria-pressed={dark} onClick={() => toggleTheme(true)} className={cx(subtleIcon, "!rounded-full", dark && "!bg-background-primary-default !shadow-xs")} /></div>
        <a href="https://github.com/HUSAM-07/vultr-containers" target="_blank" rel="noreferrer" className="flex h-9 items-center gap-3 rounded-lg px-2 text-body-regular text-text-secondary hover:bg-background-secondary-hover"><RiHeadphoneLine className="size-[18px]" aria-hidden />Support</a>
        <button type="button" onClick={() => toggleTheme(!dark)} className="flex h-9 items-center gap-3 rounded-lg px-2 text-body-regular text-text-secondary hover:bg-background-secondary-hover"><RiSettings3Line className="size-[18px]" aria-hidden />Settings</button>
        <div className="mt-2 flex items-center gap-2 rounded-xl bg-background-tertiary-default p-3"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-200 text-body-medium text-accent-700">B</span><div className="min-w-0 flex-1"><p className="truncate text-body-medium">Board team</p><p className="text-caption-1-regular text-text-tertiary">Pro Plan</p></div><button type="button" title="Plan management is not available in this preview" aria-disabled="true" className="rounded-lg bg-background-primary-default px-3 py-1.5 text-body-medium shadow-xs">Upgrade</button></div>
      </div>
    </aside>

    <section className={cx("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-3xl bg-background-secondary-default max-sm:rounded-none", !inspectorHidden && "w-[calc(100%+14px)] max-lg:w-full")}>
      <header className="flex h-14 shrink-0 items-center justify-between px-5"><div className="flex min-w-0 items-center gap-2 text-body-regular text-text-secondary"><Button variant="ghost" size="xs" iconOnly leadingIcon={RiMenuLine} aria-label="Open sidebar" onClick={openSidebar} className={cx(subtleIcon, !sidebarHidden && "lg:!hidden")} /><RiFolder3Line className="size-4 shrink-0 text-foreground-icon-tertiary" aria-hidden /><span className="truncate text-text-tertiary">{project}</span><RiArrowRightSLine className="size-4 shrink-0" aria-hidden /><span className="truncate">{current?.task || example || "New agent"}</span></div><div className="flex items-center gap-1"><Button variant="ghost" size="xs" iconOnly leadingIcon={RiUpload2Line} aria-label="Copy page link" className={subtleIcon} onClick={() => void navigator.clipboard?.writeText(location.href)} /><Button variant="ghost" size="xs" iconOnly leadingIcon={RiMoreLine} aria-label="New agent" className={subtleIcon} onClick={newAgent} /><Button variant="ghost" size="xs" iconOnly leadingIcon={RiLayoutRightLine} aria-label="Open inspector" onClick={openInspector} className={cx(subtleIcon, !inspectorHidden && "lg:!hidden")} /></div></header>
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-y-auto ps-4 pe-4 pb-2">
        {current || showExample ? <div className="mx-auto flex w-full max-w-[1810px] flex-col gap-3"><div className={cx("ms-auto max-w-[80%] rounded-2xl border border-border-button-default bg-background-primary-default px-3 py-2 text-body-regular whitespace-pre-line shadow-card", showExample && "-me-1.5 w-[910px]")}>{current?.task || examplePrompt.replace("you're done.", "you're\ndone.")}</div><div className="text-body-regular">{current ? current.summary || current.error || (current.status === "running" || current.status === "queued" ? "Working on your request…" : "Review the execution result below.") : exampleReply}</div>
          {current && (current.status === "running" || current.status === "queued") && <AgentThinking variant="wave" label="Working in the sandbox" />}
          {current?.plan?.length ? <ol className="flex flex-wrap gap-x-5 gap-y-1 text-caption-1-regular text-text-secondary">{current.plan.map((step, index) => <li key={index}>{index + 1}. {step}</li>)}</ol> : null}
          {(current?.code || showExample) && <div className="overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-card"><div className="flex h-9 items-center justify-between border-b border-separator-border px-3 text-caption-1-regular text-text-secondary"><span><span className="me-2 rounded bg-docs-file-chip-background px-1.5 py-0.5 text-docs-file-chip-foreground">{current ? "PY" : "TSX"}</span>{current ? "agent.py" : "theme-toggle.tsx"}</span><span className="flex items-center gap-2"><span className="text-chart-7-active">+{current ? additions : 156}</span>{!current && <span className="text-text-error-primary">-23</span>}<Button variant="ghost" size="xs" iconOnly leadingIcon={RiFileCopyLine} aria-label="Copy code" className={subtleIcon} onClick={() => void navigator.clipboard?.writeText(current?.code || exampleCode)} /></span></div><div className="max-h-[148px] overflow-auto pt-3 pb-[7px]"><CodeLines code={current?.code || exampleCode} limit={7} compact /></div></div>}
          {current?.output && <pre className="max-h-28 overflow-auto rounded-lg bg-background-primary-default p-3 font-mono text-caption-1-regular text-text-secondary whitespace-pre-wrap">{current.output.stdout || current.output.stderr || "(no output)"}</pre>}
          {showExample && <div className="flex items-center gap-1.5 text-text-tertiary"><Button variant="ghost" size="xs" iconOnly leadingIcon={RiThumbUpLine} aria-label="Good response" className="!size-7 !bg-background-tertiary-default !text-foreground-icon-tertiary [&_svg]:!size-4" /><Button variant="ghost" size="xs" iconOnly leadingIcon={RiThumbDownLine} aria-label="Bad response" className="!size-7 !bg-background-tertiary-default !text-foreground-icon-tertiary [&_svg]:!size-4" /><Button variant="ghost" size="xs" iconOnly leadingIcon={RiFileCopyLine} aria-label="Copy response" className="!size-7 !bg-background-tertiary-default !text-foreground-icon-tertiary [&_svg]:!size-4" onClick={() => void navigator.clipboard?.writeText(exampleReply)} /></div>}
        </div> : <div className="mx-auto flex w-full max-w-xl flex-col gap-4 pb-14 text-center"><h1 className="text-title-2-medium">What should we build?</h1><p className="text-body-regular text-text-secondary">Describe a product task. Forge plans it, writes code, and runs it in an isolated container.</p><div className="flex flex-col gap-2">{suggestions.map(suggestion => <button key={suggestion} type="button" onClick={() => setTask(suggestion)} className="rounded-xl border border-border-button-default bg-background-primary-default p-3 text-start text-body-regular text-text-secondary hover:bg-background-primary-hover">{suggestion}</button>)}</div></div>}
      </div>
      <div className="shrink-0 px-[9px] pb-3"><form onSubmit={event => { event.preventDefault(); void submit(); }} className="flex min-h-14 items-center gap-2 rounded-full border border-border-button-default bg-background-primary-default px-2 py-1 shadow-card"><Button variant="ghost" size="small" iconOnly leadingIcon={RiAddLine} aria-label="New agent" onClick={newAgent} className="!rounded-full !bg-background-secondary-default !text-foreground-icon-primary" /><Textarea aria-label="Ask me anything" placeholder="Ask me anything" value={task} onChange={setTask} rows={1} autoResize maxRows={4} maxLength={2000} className="min-w-0 flex-1" fieldClassName="!rounded-none !bg-transparent !p-0 !ring-0" /><span className="hidden shrink-0 items-center gap-1 text-body-regular text-text-secondary sm:flex">{provider.includes("OpenRouter") ? "GPT-6 Luna" : "Vultr model"}<RiArrowDownSLine className="size-4" aria-hidden /></span><Button variant="ghost" size="small" iconOnly leadingIcon={RiMicLine} aria-label="Voice input unavailable" disabled className="!rounded-full !text-foreground-icon-secondary" /><Button type="submit" size="small" iconOnly leadingIcon={RiArrowUpLine} aria-label="Send task" disabled={pending} className="!rounded-full" /></form>
        {error && <p role="alert" className="px-3 pt-1 text-caption-1-regular text-text-error-primary">{error}</p>}
        <div className="flex h-9 items-center justify-between gap-3 px-2 text-body-regular text-text-secondary"><div className="flex min-w-0 items-center gap-3"><span className="flex items-center gap-1"><RiGitBranchLine className="size-4" aria-hidden />Main</span><span className="flex min-w-0 items-center gap-1 truncate"><RiFolder3Line className="size-4 shrink-0" aria-hidden />{showExample ? "project-sea" : project}<RiArrowDownSLine className="size-4 shrink-0" aria-hidden /></span></div><div className="flex shrink-0 items-center gap-3"><span className="flex items-center gap-1">∞ Agent<RiArrowDownSLine className="size-4" aria-hidden /></span><span title={provider} className="flex items-center gap-1 rounded-full bg-background-tertiary-default px-2 py-0.5 text-caption-1-regular"><span className="size-3.5 rounded-full border-2 border-border-button-default border-t-foreground-icon-secondary" aria-hidden />{configured === null ? "…" : configured ? (showExample ? "57%" : "Ready") : "Setup"}</span></div></div>
      </div>
    </section>

    <aside className={cx("flex min-h-0 min-w-0 flex-col overflow-hidden bg-background-primary-default lg:w-[calc(100%+8px)] max-lg:fixed max-lg:inset-y-2 max-lg:right-2 max-lg:z-30 max-lg:w-[min(424px,calc(100vw-16px))] max-lg:rounded-2xl max-lg:border max-lg:border-border-button-default max-lg:shadow-sidebar", inspectorHidden && !expanded && "lg:hidden", inspectorOpen ? "max-lg:flex" : "max-lg:hidden", expanded && "!fixed !inset-2 !z-40 !w-auto rounded-2xl border border-border-button-default shadow-sidebar")}>
      <header className="flex h-[58px] shrink-0 items-start justify-between gap-2 pe-2 ps-[11px] pt-[9px]"><div className="flex min-w-0 items-center gap-1"><button type="button" onClick={() => setPanel("changes")} className={cx("flex h-[30px] translate-y-0.5 items-center gap-1.5 rounded-full px-2 text-body-medium", panel === "changes" ? "reference-selected-tab bg-accent-50 text-accent-400" : "text-text-secondary")}><RiInfinityLine className="size-4" aria-hidden />Changes</button><button type="button" onClick={() => setPanel("browser")} className={cx("flex h-[30px] translate-y-0.5 items-center gap-1.5 rounded-full px-2 text-body-medium", panel === "browser" ? "reference-selected-tab bg-accent-50 text-accent-400" : "text-text-secondary")}><RiGlobalLine className="size-4" aria-hidden />Browser</button></div><div className="flex items-center gap-0.5"><Button variant="ghost" size="xs" iconOnly leadingIcon={RiTerminalLine} aria-label="Execution logs" className={subtleIcon} onClick={() => setPanel("logs")} /><Button variant="ghost" size="xs" iconOnly leadingIcon={RiExpandDiagonalLine} aria-label={expanded ? "Restore inspector" : "Expand inspector"} className={subtleIcon} onClick={() => setExpanded(value => !value)} /><Button variant="ghost" size="xs" iconOnly leadingIcon={RiLayoutRightLine} aria-label="Close inspector" className={subtleIcon} onClick={closeInspector} /></div></header>
      {panel === "changes" ? <><div className="flex h-9 shrink-0 items-center justify-between border-y border-separator-border px-3 text-body-regular text-text-secondary"><span>{current ? current.code ? "1 Generated file" : "No generated file" : "12 Uncommitted changes"} {(!current || additions > 0) && <span className="text-chart-7-active">+{current ? additions : 156}</span>} {!current && <span className="text-text-error-primary">-23</span>}</span><RiArrowGoBackLine className="size-4" aria-hidden /></div><div className="flex h-9 shrink-0 items-center justify-between gap-2 bg-background-secondary-default px-2 text-body-regular"><span className="flex min-w-0 items-center truncate">{current ? <RiCodeLine className="me-1 size-4 shrink-0 text-accent-600" aria-hidden /> : <RiReactjsLine className="me-1 size-4 shrink-0 text-accent-600" aria-hidden />}{current ? "agent.py" : "boardui/app/components/button.tsx"} {(!current || additions > 0) && <span className="ms-1 text-chart-7-active">+{current ? additions : 74}</span>}</span><span className="rounded bg-background-tertiary-default px-1.5 text-caption-1-regular text-text-secondary">New</span></div><div className="min-h-0 flex-1 overflow-auto pe-3 ps-[14px] py-3">{current && !current.code ? <p className="text-body-regular text-text-secondary">The agent has not generated source yet.</p> : <CodeLines code={current?.code || exampleSideCode} />}{current?.steps?.length ? <div className="border-t border-separator-border p-4"><p className="mb-3 text-caption-1-semibold text-text-tertiary">EXECUTION STEPS</p><AgentSteps steps={current.steps} /></div> : null}</div></> : panel === "logs" ? <div className="min-h-0 flex-1 overflow-auto border-t border-separator-border p-4"><div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-body-medium">Execution logs</h2><button type="button" disabled={pending} onClick={() => void submit("containment")} className="flex items-center gap-1 text-caption-1-regular text-text-secondary hover:text-text-primary"><RiShieldCheckLine className="size-4" aria-hidden />Run containment demo</button></div>{current?.steps?.length ? <AgentSteps steps={current.steps} /> : <p className="text-body-regular text-text-secondary">Start a run to see sandbox steps and output.</p>}{current?.output && <pre className="mt-4 whitespace-pre-wrap rounded-xl bg-background-secondary-default p-3 font-mono text-caption-1-regular">{current.output.stdout || current.output.stderr || "(no output)"}</pre>}</div> : <div className="min-h-0 flex-1 overflow-auto border-t border-separator-border p-3">{current?.artifact ? <iframe title="Generated product preview" sandbox="" referrerPolicy="no-referrer" className="h-full min-h-[460px] w-full rounded-xl border border-border-button-default bg-background-primary-default" srcDoc={'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">' + current.artifact} /> : <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-text-secondary"><RiGlobalLine className="size-8 text-foreground-icon-tertiary" aria-hidden /><p className="text-body-medium">No browser preview yet</p><p className="max-w-xs text-body-regular">Ask Forge to build a static page, then its sandbox-generated preview appears here.</p></div>}</div>}
    </aside>
  </main>;
}
