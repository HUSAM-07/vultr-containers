export type ConformanceReport = { pass: boolean; unmet: string[]; unrelated: string[]; evidence: string[] };

export class ReviewError extends Error {}

function validList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 25 && value.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 300);
}

export function parseConformanceReport(report: unknown): ConformanceReport {
  if (!report || typeof report !== "object" || !("pass" in report) || typeof report.pass !== "boolean" ||
    !("unmet" in report) || !validList(report.unmet) || !("unrelated" in report) || !validList(report.unrelated) ||
    !("evidence" in report) || !validList(report.evidence) ||
    (report.pass && (report.unmet.length > 0 || report.unrelated.length > 0 || report.evidence.length === 0)))
    throw new ReviewError("Spec review model returned an inconsistent verdict");
  return report as ConformanceReport;
}
