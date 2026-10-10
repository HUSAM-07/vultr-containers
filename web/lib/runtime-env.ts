import type { env as CloudflareEnv } from "cloudflare:workers";

// Vite replaces this module with native Worker bindings; Next keeps the Forge demo buildable.
export const env = { DB: null } as unknown as typeof CloudflareEnv;
