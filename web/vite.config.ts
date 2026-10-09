import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    { name: "fava-worker-env", enforce: "pre", resolveId(id) {
      if (id === "@/lib/runtime-env") return { id: "cloudflare:workers", external: true };
    } },
    tailwindcss(),
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
