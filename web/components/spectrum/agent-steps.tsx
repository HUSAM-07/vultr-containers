"use client";

// Adapted from Spectrum UI Agent Steps (Apache-2.0):
// https://github.com/arihantcodes/spectrum-ui/blob/main/components/spectrumui/blocks/ai-assistants/agent-steps.tsx
// Changed: BoardUI semantic tokens, Remix icons, and the app's run-step data.
import { useState } from "react";
import { RiArrowDownSLine, RiCheckLine, RiCloseLine, RiLoader4Line } from "@remixicon/react";
import { cx } from "@/utils/cx";

export type Step = {
  name: string;
  status: "running" | "success" | "error";
  result?: string;
  startedAt: number;
  completedAt?: number;
};

export function AgentSteps({ steps }: { steps: Step[] }) {
  return <ol className="flex flex-col" aria-label="Agent execution steps">
    {steps.map((step, index) => <StepRow key={index} step={step} last={index === steps.length - 1} />)}
  </ol>;
}

function StepRow({ step, last }: { step: Step; last: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = step.status === "success" ? RiCheckLine : step.status === "error" ? RiCloseLine : RiLoader4Line;
  const duration = step.completedAt ? ((step.completedAt - step.startedAt) / 1000).toFixed(1) + "s" : null;
  return <li className="flex gap-3">
    <div className="flex flex-col items-center">
      <span className={cx("grid size-6 shrink-0 place-items-center rounded-full",
        step.status === "success" ? "bg-notification-success-background text-notification-success-foreground" :
        step.status === "error" ? "bg-notification-error-background text-notification-error-foreground" :
        "bg-background-secondary-default text-foreground-icon-secondary")}>
        <Icon className={cx("size-4", step.status === "running" && "motion-safe:animate-spin")} aria-hidden />
      </span>
      {!last && <span className="w-px flex-1 bg-separator-border" />}
    </div>
    <div className={cx("min-w-0 flex-1", !last && "pb-5")}>
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg text-start outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring">
        <span className="min-w-0 flex-1 truncate text-body-medium text-text-primary">{step.name}</span>
        <span className="text-caption-1-medium text-text-tertiary">{duration || step.status}</span>
        <RiArrowDownSLine className={cx("size-4 text-foreground-icon-tertiary transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-background-secondary-default p-3 text-caption-1-regular text-text-secondary whitespace-pre-wrap">{step.result || "Running in a sandbox…"}</pre>}
    </div>
  </li>;
}
