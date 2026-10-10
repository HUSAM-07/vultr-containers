export function acceptanceCriteria(spec: string): string[] {
  const section = spec.split(/^## /m).slice(1).find(block => block.split("\n", 1)[0].trim().toLowerCase() === "acceptance criteria");
  const body = section?.split("\n").slice(1).join("\n").trim() || "";
  if (!body) return [];
  const bullets = [...body.matchAll(/^ {0,3}(?:[-*]|\d+[.)])[ \t]+/gm)];
  return bullets.length ? bullets.map((bullet, index) => body.slice(
    bullet.index + bullet[0].length, bullets[index + 1]?.index).trim().replace(/\s+/g, " ")) : [body];
}

export function specValidationError(title: string, content: string): string | null {
  const cleanTitle = title.trim();
  const cleanContent = content.trim();
  if (cleanTitle.length < 5 || cleanTitle.length > 120) return "Use a 5–120 character specification title";
  if (cleanContent.length < 80 || cleanContent.length > 40_000)
    return "Use an 80–40,000 character specification";
  const sections = cleanContent.split(/^## /m).slice(1).map(block => {
    const [name, ...body] = block.split("\n");
    return { name: name.trim().toLowerCase(), body: body.join("\n").trim() };
  });
  for (const heading of ["Outcome", "Scope", "Acceptance criteria"])
    if (!sections.some(section => section.name === heading.toLowerCase() && section.body.length >= 20))
      return `Add a concrete ${heading.toLowerCase()} section`;
  if (cleanContent.includes("Describe the result a user should experience") ||
    cleanContent.includes("Describe what must be built") ||
    cleanContent.includes("Describe an observable behavior"))
    return "Replace the template guidance with your own specification";
  if (acceptanceCriteria(cleanContent).length > 25)
    return "Use at most 25 acceptance criteria per specification";
  return null;
}
