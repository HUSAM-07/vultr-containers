export const agentModels = [
  { provider: "openai", model: "gpt-6-sol", label: "Codex · GPT-6 Sol" },
  { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Code · Sonnet 5" },
] as const;

export function chooseModel(value: unknown) {
  const selected = agentModels.find(item => item.model === value);
  if (!selected) throw Error("Choose a supported agent model");
  return selected;
}
