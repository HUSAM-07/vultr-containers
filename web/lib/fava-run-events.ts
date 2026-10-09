export type RunEvent = { id: string; label: string; status: "running" | "passed" | "failed" | "complete" };

export function runEvents(stdout: string): RunEvent[] {
  const events: RunEvent[] = [];
  const positions = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; } // A bounded live log may begin or end mid-event.
    if (!value || typeof value !== "object") continue;
    const item = value.item as Record<string, unknown> | undefined;
    if (value.type === "item.started" || value.type === "item.completed") {
      if (item?.type !== "command_execution" || typeof item.command !== "string") continue;
      const id = typeof item.id === "string" ? item.id : `command-${events.length}`;
      const event: RunEvent = { id, label: item.command.slice(0, 240),
        status: value.type === "item.started" ? "running" : item.exit_code === 0 ? "passed" : "failed" };
      const position = positions.get(id);
      if (position === undefined) { positions.set(id, events.length); events.push(event); }
      else events[position] = event;
    } else if (value.type === "assistant" && value.message && typeof value.message === "object") {
      const message = value.message as { content?: unknown };
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type !== "tool_use" || typeof block.name !== "string" || typeof block.id !== "string") continue;
        if (positions.has(block.id)) continue;
        positions.set(block.id, events.length);
        events.push({ id: block.id, label: block.name, status: "running" });
      }
    } else if (value.type === "user" && value.message && typeof value.message === "object") {
      const message = value.message as { content?: unknown };
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const position = positions.get(block.tool_use_id);
        if (position !== undefined) events[position] = { ...events[position], status: block.is_error ? "failed" : "complete" };
      }
    }
  }
  return events.slice(-80);
}
