export type ConformanceReport = { pass: boolean; unmet: string[]; unrelated: string[]; evidence: string[];
  fileEvidence: { path: string; criterion: number; reason: string }[] };

export class ReviewError extends Error {}

function validList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 25 && value.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 300);
}

export function parseConformanceReport(report: unknown): ConformanceReport {
  if (!report || typeof report !== "object" || !("pass" in report) || typeof report.pass !== "boolean" ||
    !("unmet" in report) || !validList(report.unmet) || !("unrelated" in report) || !validList(report.unrelated) ||
    !("evidence" in report) || !validList(report.evidence) || !("fileEvidence" in report) ||
    !Array.isArray(report.fileEvidence) || report.fileEvidence.length > 25 ||
    !report.fileEvidence.every(item => item && typeof item === "object" &&
      typeof item.path === "string" && item.path.length > 0 && item.path.length <= 300 &&
      Number.isSafeInteger(item.criterion) && typeof item.reason === "string" &&
      item.reason.trim().length > 0 && item.reason.length <= 300) ||
    (report.pass && (report.unmet.length > 0 || report.unrelated.length > 0 || report.evidence.length === 0)))
    throw new ReviewError("Spec review model returned an inconsistent verdict");
  return report as ConformanceReport;
}

export function verifyConformanceCoverage(report: ConformanceReport, criteriaCount: number, paths: string[]) {
  if (!report.pass) return;
  if (report.evidence.length !== criteriaCount || report.fileEvidence.length !== paths.length ||
    new Set(paths).size !== paths.length || new Set(report.fileEvidence.map(item => item.path)).size !== paths.length ||
    report.fileEvidence.some(item => !paths.includes(item.path) || item.criterion < 1 || item.criterion > criteriaCount))
    throw new ReviewError("Spec review model returned an inconsistent verdict");
}
