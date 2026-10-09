"use client";

import { useEffect, useState } from "react";
import { LogRow, useLogMotion, WorkingRow } from "@/components/application/agent-log/agent-log";

export function RunLog({ id, running }: { id: string; running: boolean }) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<{ stdout: string; stderr: string } | null>(null);
  const [error, setError] = useState("");
  const reduce = useLogMotion();

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
      {logs && <ol className="space-y-2">
        {(["stdout", "stderr"] as const).filter(kind => logs[kind]).map((kind, index, kinds) =>
          <LogRow key={kind} first={index === 0} last={index === kinds.length - 1} reduce={reduce}>
            <p className="py-1 text-caption-1-semibold text-text-secondary">{kind === "stdout" ? "Output" : "Errors"}</p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-caption-1-regular text-text-secondary" dir="ltr">{logs[kind]}</pre>
          </LogRow>)}
      </ol>}
      {logs && !logs.stdout && !logs.stderr && <p className="text-caption-1-regular text-text-secondary">No output yet.</p>}
      {running && <WorkingRow label="Agent working" reduce={reduce} />}
    </div>}
  </details>;
}
