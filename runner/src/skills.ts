import { pinnedRunSkills } from "../../web/lib/fava-run-skills.ts";
import type { Env } from "./types.ts";

export function loadRunSkills(env: Env, runId: string) {
  return pinnedRunSkills(env.DB, runId, env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_PRIVATE_KEY);
}
