import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command }) => ({
  resolve: command === "build"
    ? { alias: [{ find: /^@\/lib\/runtime-env$/, replacement: "cloudflare:workers" }] }
    : undefined,
  plugins: [
    {
      name: "fava-worker-env-dev",
      apply: "serve",
      enforce: "pre",
      resolveId(id) {
        if (id === "@/lib/runtime-env") return { id: "cloudflare:workers", external: true };
      },
    },
    tailwindcss(),
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
}));
