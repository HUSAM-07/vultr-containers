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
      DB: bindings.d1({ name: "fava-core" }),
      FAVA_SESSION_SECRET: bindings.secret(),
      GITHUB_APP_CLIENT_ID: bindings.secret(),
      GITHUB_APP_CLIENT_SECRET: bindings.secret(),
      GITHUB_APP_SLUG: bindings.secret(),
      GITHUB_APP_PRIVATE_KEY: bindings.secret(),
      GITHUB_WEBHOOK_SECRET: bindings.secret(),
    },
  }),
});
