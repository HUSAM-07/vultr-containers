import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "fava-platform",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-10-09",
    compatibilityFlags: ["nodejs_compat"],
    observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true, headSamplingRate: 0.01 } },
    assets: { notFoundHandling: "none" },
    env: {
      ASSETS: bindings.assets(),
      DB: bindings.d1({ name: "fava-core", id: "7d58c3df-31b0-40ef-823a-11b59bbe2a84" }),
      ARTIFACTS: bindings.r2({ name: "fava-run-artifacts" }),
      FAVA_SESSION_SECRET: bindings.secret(),
      GITHUB_APP_CLIENT_ID: bindings.secret(),
      GITHUB_APP_CLIENT_SECRET: bindings.secret(),
      GITHUB_APP_SLUG: bindings.secret(),
      GITHUB_APP_PRIVATE_KEY: bindings.secret(),
      GITHUB_WEBHOOK_SECRET: bindings.secret(),
      CLOUDFLARE_OAUTH_CLIENT_ID: bindings.secret(),
      CLOUDFLARE_OAUTH_CLIENT_SECRET: bindings.secret(),
    },
  }),
});
