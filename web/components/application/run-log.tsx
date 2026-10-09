"use client";

import { useEffect, useState } from "react";
import { LogRow, useLogMotion, WorkingRow } from "@/components/application/agent-log/agent-log";
import { runEvents } from "@/lib/fava-run-events";

export function RunLog({ id, running }: { id: string; running: boolean }) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<{ stdout: string; stderr: string } | null>(null);
  const [error, setError] = useState("");
  const reduce = useLogMotion();
  const events = logs ? runEvents(logs.stdout) : [];

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    async function refresh() {
      try {
        const [stdout, stderr] = await Promise.all((["stdout", "stderr"] as const).map(async kind => {
          const response = await fetch(`/api/github/runs/${id}/artifact?kind=${kind}`, {
            cache: "no-store", signal: controller.signal,
          });
          if (!response.ok) throw Error(`Could not load ${kind} (${response.status})`);
          return response.text();
        }));
        if (!controller.signal.aborted) { setLogs({ stdout, stderr }); setError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      }
    }
    void refresh();
    const timer = running ? window.setInterval(() => void refresh(), 20_000) : null;
    return () => { controller.abort(); if (timer !== null) window.clearInterval(timer); };
  }, [id, open, running]);

  return <details className="mt-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-body-medium text-accent-600">Agent log{running ? " (live)" : ""}</summary>
    {open && <div className="mt-3 rounded-xl border border-border-button-default bg-background-secondary-default p-3">
      {error && <p role="alert" className="text-caption-1-regular text-text-error-primary">{error}</p>}
      {!logs && !error && <p className="text-caption-1-regular text-text-secondary">Loading log…</p>}
      {logs && <>
        {events.length > 0 && <><p className="mb-2 text-caption-1-semibold text-text-secondary">Agent actions</p>
          <ol className="space-y-2">{events.map((event, index) =>
            <LogRow key={event.id} first={index === 0} last={index === events.length - 1} reduce={reduce}>
              <p className="break-words py-1 font-mono text-caption-1-regular text-text-secondary" dir="ltr">{event.label}</p>
              <p className={event.status === "failed" ? "text-caption-1-semibold text-text-error-primary" : "text-caption-1-regular text-text-tertiary"}>{event.status}</p>
            </LogRow>)}</ol></>}
        <details className="mt-3"><summary className="cursor-pointer text-caption-1-semibold text-accent-600">Raw output and errors</summary>
          <ol className="mt-2 space-y-2">{(["stdout", "stderr"] as const).filter(kind => logs[kind]).map((kind, index, kinds) =>
            <LogRow key={kind} first={index === 0} last={index === kinds.length - 1} reduce={reduce}>
              <p className="py-1 text-caption-1-semibold text-text-secondary">{kind === "stdout" ? "Output" : "Errors"}</p>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-caption-1-regular text-text-secondary" dir="ltr">{logs[kind]}</pre>
            </LogRow>)}</ol>
        </details>
      </>}
      {logs && !logs.stdout && !logs.stderr && <p className="text-caption-1-regular text-text-secondary">No output yet.</p>}
      {running && <WorkingRow label="Agent working" reduce={reduce} />}
    </div>}
  </details>;
}
