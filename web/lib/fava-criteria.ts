export function acceptanceCriteria(spec: string): string[] {
  const section = spec.split(/^## /m).slice(1).find(block => block.split("\n", 1)[0].trim().toLowerCase() === "acceptance criteria");
  const body = section?.split("\n").slice(1).join("\n").trim() || "";
  if (!body) return [];
  const bullets = [...body.matchAll(/^ {0,3}(?:[-*]|\d+[.)])[ \t]+/gm)];
  return bullets.length ? bullets.map((bullet, index) => body.slice(
    bullet.index + bullet[0].length, bullets[index + 1]?.index).trim().replace(/\s+/g, " ")) : [body];
}
