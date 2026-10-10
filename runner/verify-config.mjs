import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
if (config.d1_databases[0].database_id === "00000000-0000-0000-0000-000000000000")
  throw Error("Set runner/wrangler.jsonc DB database_id to the same fava-core D1 database used by the web Worker");
