import { AgentSandbox } from "./sandbox";
import { Outbound } from "./outbound";
import { dispatch, reconcile } from "./queue";
import type { Env } from "./types";

export { AgentSandbox, Outbound };

export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/health") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await reconcile(env);
    await dispatch(env);
  },
} satisfies ExportedHandler<Env>;
