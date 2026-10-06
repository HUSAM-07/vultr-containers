"use client";

import { useCallback, useEffect, useState } from "react";
import { RiAddLine, RiArrowUpLine, RiCodeLine, RiFolder3Line, RiRefreshLine, RiShieldCheckLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Textarea } from "@/components/base/textarea/textarea";
import { AgentThinking } from "@/components/application/agent-thinking/agent-thinking";
import { AgentSteps, type Step } from "@/components/spectrum/agent-steps";
import { cx } from "@/utils/cx";

type Run = {
  id: string;
  task: string;
  project: string;
  mode: "build" | "containment";
  status: "queued" | "running" | "succeeded" | "failed";
  plan: string[];
  steps: Step[];
  createdAt: number;
  completedAt?: number;
  summary?: string;
  error?: string;
  code?: string;
  output?: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
};

const suggestions = [
  "Build a simple pricing calculator for a subscription product and test three plans.",
  "Create a cohort retention analysis with sample data and print the results.",
  "Write and run a validator for a CSV product import with malformed rows.",
];

export default function Home() {
  const [projects, setProjects] = useState(["General"]);
  const [restored, setRestored] = useState(false);
  const [project, setProject] = useState("General");
  const [newProject, setNewProject] = useState("");
  const [adding, setAdding] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<Run | null>(null);
  const [task, setTask] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [inspector, setInspector] = useState<"output" | "code">("output");

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("forge:projects") || "[]");
      if (Array.isArray(saved) && saved.every(item => typeof item === "string"))
        // eslint-disable-next-line react-hooks/set-state-in-effect -- restore browser state after hydration
        setProjects(["General", ...saved.filter(item => item !== "General")]);
    } catch { /* local storage may be unavailable */ }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (restored) {
      try { localStorage.setItem("forge:projects", JSON.stringify(projects)); }
      catch { /* local storage may be unavailable */ }
    }
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh updates state only after the HTTP response
    void refresh();
    fetch("/api/backend/health").then(response => response.json())
      .then(value => setConfigured(Boolean(value.configured)))
      .catch(() => setConfigured(false));
  }, [refresh]);
  const hasActiveRuns = runs.some(run => run.status === "running" || run.status === "queued");
  useEffect(() => {
    if (!hasActiveRuns) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [hasActiveRuns, refresh]);
  const pollSelected = selected?.id !== selectedId || selected?.status === "running" || selected?.status === "queued";
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/backend/runs/" + selectedId, { cache: "no-store" });
        if (response.ok) {
          const value = await response.json();
          if (!cancelled) setSelected(value);
        }
      } catch { /* next poll retries */ }
    };
    void load();
    if (!pollSelected) return () => { cancelled = true; };
    const timer = setInterval(load, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selectedId, pollSelected]);

  async function submit(mode: "build" | "containment" = "build") {
    if (pending || (!task.trim() && mode === "build")) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/backend/runs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, task: mode === "containment" ? "Demonstrate sandbox time limit" : task.trim(), mode }),
      });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || "Run could not start");
      setSelected(value);
      setSelectedId(value.id);
      setTask("");
      void refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(false); }
  }

  function addProject() {
    const name = newProject.trim();
    if (!name || name.length > 80) return;
    setProjects(current => current.includes(name) ? current : [...current, name]);
    setProject(name);
    setNewProject("");
    setAdding(false);
    setSelectedId("");
    setSelected(null);
  }

  const projectRuns = runs.filter(run => run.project === project);
  const current = selected?.project === project ? selected : null;
  return <main className="flex min-h-dvh flex-col gap-3 bg-background-full p-3 text-text-primary lg:h-dvh lg:flex-row">
    <aside className="flex w-full shrink-0 flex-col rounded-3xl border border-border-button-default bg-background-primary-default p-4 lg:w-64">
      <div className="flex items-center gap-3 pb-6">
        <span className="grid size-9 place-items-center rounded-xl bg-button-primary text-text-white"><RiCodeLine className="size-5" aria-hidden /></span>
        <div className="min-w-0">
          <p className="text-headline-medium">Forge</p>
          <p className="text-caption-1-regular text-text-tertiary">Vultr Agent Rush</p>
        </div>
      </div>
      <Button variant="secondary" leadingIcon={RiAddLine} onClick={() => { setSelectedId(""); setSelected(null); setTask(""); }}>
        New run
      </Button>
      <div className="mt-8 flex items-center justify-between">
        <span className="text-caption-1-semibold text-text-tertiary">PROJECTS</span>
        <Button variant="ghost" size="xs" iconOnly leadingIcon={RiAddLine} aria-label="Add project" onClick={() => setAdding(value => !value)} />
      </div>
      {adding && <form className="mt-2 flex gap-1" onSubmit={event => { event.preventDefault(); addProject(); }}>
        <Input aria-label="Project name" placeholder="Project name" value={newProject} onChange={setNewProject} maxLength={80} />
        <Button type="submit" size="small" iconOnly leadingIcon={RiArrowUpLine} aria-label="Save project" />
      </form>}
      <nav className="mt-3 flex flex-col gap-1" aria-label="Projects">
        {projects.map(name => <button key={name} type="button" onClick={() => { setProject(name); setSelectedId(""); setSelected(null); }}
          className={cx("flex items-center gap-2 rounded-xl px-3 py-2 text-start text-body-medium transition-colors hover:bg-background-secondary-hover",
            name === project ? "bg-background-secondary-default text-text-primary" : "text-text-secondary")}>
          <RiFolder3Line className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
          <span className="truncate">{name}</span>
        </button>)}
      </nav>
      <div className="mt-8 flex items-center justify-between">
        <span className="text-caption-1-semibold text-text-tertiary">RECENT RUNS</span>
        <Button variant="ghost" size="xs" iconOnly leadingIcon={RiRefreshLine} aria-label="Refresh runs" onClick={() => void refresh()} />
      </div>
      <div className="mt-3 flex flex-col gap-1 overflow-auto">
        {projectRuns.length ? projectRuns.map(run => <button key={run.id} type="button" onClick={() => { setSelectedId(run.id); setSelected(null); }}
          className={cx("rounded-xl px-3 py-2 text-start transition-colors hover:bg-background-secondary-hover",
            selectedId === run.id && "bg-background-secondary-default")}>
          <span className="block truncate text-body-2-medium text-text-primary">{run.task}</span>
          <span className="text-caption-1-regular text-text-tertiary">{run.status} · {new Date(run.createdAt).toLocaleTimeString()}</span>
        </button>) : <p className="px-3 py-2 text-body-2-regular text-text-tertiary">No runs yet</p>}
      </div>
      <div className="mt-auto border-t border-separator-border pt-4">
        <div className="flex items-center gap-2 text-body-2-medium text-text-secondary">
          <RiShieldCheckLine className="size-4 text-foreground-icon-secondary" aria-hidden />
          Isolated execution on Vultr
        </div>
      </div>
    </aside>

    <section className="flex min-h-[620px] min-w-0 flex-1 flex-col rounded-3xl border border-border-button-default bg-background-secondary-default lg:min-h-0">
      <header className="flex items-center justify-between border-b border-separator-border px-6 py-4">
        <div>
          <p className="text-caption-1-regular text-text-tertiary">Project / {project}</p>
          <h1 className="text-headline-medium">Product builder</h1>
        </div>
        <span className="rounded-full bg-background-primary-default px-3 py-1 text-caption-1-semibold text-text-secondary">
          {configured === null ? "Checking Vultr" : configured ? "Vultr ready" : "Setup needed"}
        </span>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        {!current ? <div className="mx-auto flex h-full max-w-xl flex-col justify-center gap-5">
          <div className="grid size-12 place-items-center rounded-2xl bg-background-primary-default"><RiCodeLine className="size-6 text-foreground-icon-primary" aria-hidden /></div>
          <div>
            <h2 className="text-title-2-medium">What should we build?</h2>
            <p className="mt-2 text-body-regular text-text-secondary">Describe a product task. Forge plans, writes Python, runs it in an isolated container, and shows the actual result.</p>
          </div>
          <div className="flex flex-col gap-2">
            {suggestions.map(suggestion => <button key={suggestion} type="button" onClick={() => setTask(suggestion)}
              className="rounded-xl border border-border-button-default bg-background-primary-default p-3 text-start text-body-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover">
              {suggestion}
            </button>)}
          </div>
        </div> : <div className="mx-auto flex max-w-2xl flex-col gap-6">
          <div className="ms-auto max-w-[85%] rounded-2xl bg-background-primary-default p-4 text-body-regular">{current.task}</div>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-lg bg-button-primary text-text-white"><RiCodeLine className="size-4" aria-hidden /></span><span className="text-body-medium">Forge agent</span></div>
            {current.status === "running" || current.status === "queued" ? <AgentThinking variant="wave" label="Working on Vultr" /> : null}
            {current.plan.length > 0 && <div className="rounded-3xl border border-border-button-default bg-background-primary-default p-5">
              <h3 className="text-body-medium">Execution plan</h3>
              <ol className="mt-3 flex flex-col gap-2">
                {current.plan.map((step, index) => <li key={index} className="flex gap-3 text-body-2-regular text-text-secondary"><span className="text-text-tertiary">{String(index + 1).padStart(2, "0")}</span>{step}</li>)}
              </ol>
            </div>}
            {(current.summary || current.error) && <p className="text-body-regular text-text-secondary">{current.summary || current.error}</p>}
            {current.output && <pre className="max-h-64 overflow-auto rounded-2xl border border-border-button-default bg-background-primary-default p-4 text-caption-1-regular text-text-primary whitespace-pre-wrap">{current.output.stdout || current.output.stderr || "(no output)"}</pre>}
          </div>
        </div>}
      </div>
      <div className="border-t border-separator-border p-4">
        <form className="mx-auto flex max-w-2xl flex-col gap-2" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <Textarea aria-label="Product task" placeholder="Describe what to build or verify…" value={task} onChange={setTask} rows={2} autoResize maxRows={5} maxLength={2000} fieldClassName="bg-background-primary-default" />
          <div className="flex items-center justify-between gap-2">
            <span className="text-caption-1-regular text-text-tertiary">Python · Vultr Inference · isolated Docker</span>
            <Button type="submit" leadingIcon={RiArrowUpLine} disabled={pending || !task.trim()}>Run task</Button>
          </div>
        </form>
        {error && <p role="alert" className="mx-auto mt-2 max-w-2xl text-caption-1-regular text-text-error-primary">{error}</p>}
      </div>
    </section>

    <aside className="flex min-h-[520px] w-full shrink-0 flex-col rounded-3xl border border-border-button-default bg-background-primary-default lg:min-h-0 lg:w-[360px] xl:w-[400px]">
      <header className="flex items-center justify-between border-b border-separator-border p-4">
        <div><h2 className="text-headline-medium">Run inspector</h2><p className="text-caption-1-regular text-text-tertiary">Proof of executed work</p></div>
        {current && <span className="rounded-full bg-background-secondary-default px-3 py-1 text-caption-1-semibold text-text-secondary">{current.status}</span>}
      </header>
      <div className="flex gap-2 border-b border-separator-border p-3">
        <Button variant={inspector === "output" ? "secondary" : "ghost"} size="small" onClick={() => setInspector("output")}>Activity</Button>
        <Button variant={inspector === "code" ? "secondary" : "ghost"} size="small" onClick={() => setInspector("code")}>Code</Button>
      </div>
      <div className="flex-1 overflow-auto p-5">
        {!current ? <div className="flex h-full flex-col justify-center gap-3 text-center"><RiShieldCheckLine className="mx-auto size-9 text-foreground-icon-tertiary" aria-hidden /><p className="text-body-medium">Every action has a receipt</p><p className="text-body-2-regular text-text-tertiary">Start a run to see sandbox steps, source, stdout, and stderr.</p></div>
          : inspector === "code" ? <pre className="overflow-auto rounded-xl bg-background-secondary-default p-4 text-caption-1-regular text-text-primary whitespace-pre-wrap">{current.code || "Agent is writing code…"}</pre>
          : <div className="flex flex-col gap-6">
            <div><p className="mb-4 text-caption-1-semibold text-text-tertiary">AGENT STEPS</p><AgentSteps steps={current.steps} /></div>
            {current.output && <div><p className="mb-2 text-caption-1-semibold text-text-tertiary">STDOUT</p><pre className="max-h-48 overflow-auto rounded-xl bg-background-secondary-default p-3 text-caption-1-regular text-text-primary whitespace-pre-wrap">{current.output.stdout || "(empty)"}</pre></div>}
            {current.output?.stderr && <div><p className="mb-2 text-caption-1-semibold text-text-tertiary">STDERR</p><pre className="max-h-48 overflow-auto rounded-xl bg-background-tertiary-error p-3 text-caption-1-regular text-text-error-primary whitespace-pre-wrap">{current.output.stderr}</pre></div>}
            {current.output && <p className="text-caption-1-regular text-text-tertiary">Exit {current.output.exitCode ?? "unknown"} · {current.output.timedOut ? "stopped at 12s" : "container removed after run"}</p>}
          </div>}
      </div>
      <footer className="border-t border-separator-border p-4">
        <Button variant="secondary" leadingIcon={RiShieldCheckLine} onClick={() => void submit("containment")} disabled={pending}>Run containment demo</Button>
        <p className="mt-2 text-caption-1-regular text-text-tertiary">Starts a loop and proves the sandbox time limit stops it.</p>
      </footer>
    </aside>
  </main>;
}
