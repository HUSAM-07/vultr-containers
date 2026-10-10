import { agentModels } from "./fava-models.ts";

export const initialSpec = `## Outcome\n\nDescribe the result a user should experience.\n\n## Scope\n\nDescribe what must be built, and what is outside this change.\n\n## Acceptance criteria\n\n- Describe an observable behavior or test.\n`;

export type SpecDraft = { title: string; content: string; model: string; executionMode: "cloud" | "local" };

export function draftKey(repo: string): string {
  return `fava:draft:${encodeURIComponent(repo)}`;
}

export function readDraft(getItem: (key: string) => string | null, repo: string): SpecDraft {
  let draft: Record<string, unknown> | null = null;
  try { draft = JSON.parse(getItem(draftKey(repo)) || "null"); } catch { /* Use the legacy draft if available. */ }
  if (!draft) {
    try {
      const legacy = JSON.parse(getItem("fava:draft") || "null");
      if (legacy?.repo === repo) draft = legacy;
    } catch { /* A corrupt browser draft should not block the editor. */ }
  }
  const model = draft?.model;
  return {
    title: typeof draft?.title === "string" ? draft.title : "",
    content: typeof draft?.content === "string" ? draft.content : initialSpec,
    model: agentModels.some(item => item.model === model) ? model as string : agentModels[0].model,
    executionMode: draft?.executionMode === "local" ? "local" : "cloud",
  };
}
