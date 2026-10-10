import { agentModels } from "./fava-models.ts";

export const initialSpec = `## Outcome\n\nDescribe the result a user should experience.\n\n## Scope\n\nDescribe what must be built, and what is outside this change.\n\n## Acceptance criteria\n\n- Describe an observable behavior or test.\n`;

export type SpecDraft = { title: string; content: string; model: string; executionMode: "cloud" | "local" };

export function draftKey(repo: string): string {
  return `fava:draft:${encodeURIComponent(repo)}`;
}

export function appendCodeReference(content: string, repo: string, sha: string, path: string,
  selection?: { startLine: number; endLine: number; text: string }): string {
  const encodedPath = path.split("/").map(segment => encodeURIComponent(segment).replace(/[()]/g, character =>
    character === "(" ? "%28" : "%29")).join("/");
  const lines = selection ? `#L${selection.startLine}-L${selection.endLine}` : "";
  const url = `https://github.com/${repo}/blob/${sha}/${encodedPath}${lines}`;
  const label = path.replace(/[\\[\]]/g, "\\$&");
  const excerpt = selection?.text.trim().slice(0, 2000);
  const entry = `- [${label}](<${url}>)${excerpt ? `\n\n${excerpt.split("\n").map(line => `> ${line}`).join("\n")}` : ""}`;
  const heading = "## Code references";
  const section = content.search(/^## Code references$/m);
  const nextHeading = section < 0 ? -1 : content.slice(section + heading.length).search(/^## /m);
  const insertAt = nextHeading < 0 ? content.length : section + heading.length + nextHeading;
  const updated = section < 0 ? `${content.trimEnd()}\n\n${heading}\n\n${entry}\n`
    : `${content.slice(0, insertAt).trimEnd()}\n\n${entry}\n\n${content.slice(insertAt).trimStart()}`;
  if (updated.length > 40_000) throw Error("The spec is full. Remove text before adding a code reference.");
  return updated;
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
