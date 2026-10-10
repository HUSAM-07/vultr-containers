export type Change = { path: string; mode: "100644" | "100755"; sha: string | null };

export function parseChanges(raw: string): Change[] {
  const fields = raw.split("\0");
  if (fields.pop() !== "") throw Error("Invalid Git change list");
  if (fields.length === 0 || fields.length % 2 !== 0 || fields.length > 50)
    throw Error("Agent must change between 1 and 25 files");
  const changes: Change[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const [, oldMode, newMode, , newSha, status] = fields[index].match(
      /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMD])$/,
    ) || [];
    const path = fields[index + 1];
    if (!status || !path || path.includes("\ufffd") || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..") ||
      ["AGENTS.md", "CLAUDE.md", "GEMINI.md"].includes(path.split("/").at(-1) || "") ||
      path.startsWith("specs/") || path.startsWith(".fava/skills/") || path.startsWith(".git/") ||
      path === ".github/copilot-instructions.md" || path.startsWith(".github/instructions/") ||
      /(^|\/)\.env($|\.)|\.(pem|key)$/i.test(path))
      throw Error(`Agent changed a protected or invalid path: ${path}`);
    if (status === "D" && (oldMode === "100644" || oldMode === "100755"))
      changes.push({ path, mode: oldMode, sha: null });
    else if (newMode === "100644" || newMode === "100755")
      changes.push({ path, mode: newMode, sha: newSha });
    else throw Error(`Unsupported Git file mode for ${path}`);
  }
  return changes;
}
