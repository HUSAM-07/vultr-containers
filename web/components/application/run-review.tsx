"use client";

import { useEffect, useState } from "react";
import { parseConformanceReport, type ConformanceReport } from "@/lib/fava-review";
import { cx } from "@/utils/cx";

export function RunReview({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<ConformanceReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || review) return;
    const controller = new AbortController();
    fetch(`/api/github/runs/${id}/artifact?kind=review`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw Error(`Could not load spec review (${response.status})`);
        return parseConformanceReport(await response.json());
      })
      .then(value => { if (!controller.signal.aborted) { setReview(value); setError(""); } })
      .catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [id, open, review]);

  return <details className="mt-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-body-medium text-accent-600">Spec review</summary>
    {open && <div className="mt-3 space-y-3 rounded-xl border border-border-button-default bg-background-secondary-default p-3">
      {error && <p role="alert" className="text-caption-1-regular text-text-error-primary">{error}</p>}
      {!review && !error && <p className="text-caption-1-regular text-text-secondary">Loading review…</p>}
      {review && <>
        <p className={review.pass ? "text-body-medium text-text-primary" : "text-body-medium text-text-error-primary"}>
          {review.pass ? "Model review passed" : "Model review rejected this change"}
        </p>
        <p className="text-caption-1-regular text-text-tertiary">This is a model judgment. Check the evidence against the merged spec and test results.</p>
        {(["evidence", "unmet", "unrelated"] as const).filter(kind => review[kind].length).map(kind => {
          const List = kind === "evidence" ? "ol" : "ul";
          return <section key={kind}>
            <h4 className="text-caption-1-semibold text-text-secondary">{kind === "evidence" ? "Evidence" : kind === "unmet" ? "Unmet criteria" : "Unrelated changes"}</h4>
            <List className={cx("mt-2 space-y-1 ps-5 text-caption-1-regular text-text-secondary", kind === "evidence" ? "list-decimal" : "list-disc")}>
              {review[kind].map((item, index) => <li key={index}>{item}</li>)}
            </List>
          </section>})}
        {review.fileEvidence.length > 0 && <section>
          <h4 className="text-caption-1-semibold text-text-secondary">Changed file reasons</h4>
          <ul className="mt-2 space-y-1 ps-5 text-caption-1-regular text-text-secondary list-disc">
            {review.fileEvidence.map(item => <li key={item.path}><code>{item.path}</code> · criterion {item.criterion}: {item.reason}</li>)}
          </ul>
        </section>}
        <a href={`/api/github/runs/${id}/artifact?kind=review`} target="_blank" rel="noreferrer"
          className="inline-block text-caption-1-semibold text-accent-600 hover:underline">Raw report</a>
      </>}
    </div>}
  </details>;
}
