import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "fava-platform",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-10-09",
    compatibilityFlags: ["nodejs_compat"],
    assets: { notFoundHandling: "none" },
    env: {
      ASSETS: bindings.assets(),
    },
  }),
});
