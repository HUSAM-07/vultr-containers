declare module "cloudflare:workers" {
  type WorkerConfig = import("cf/config").UnwrapConfig<typeof import("./cloudflare.config").default>;
  type Worker = import("cf/config").UnwrapConfig<WorkerConfig["worker"]>;
  export const env: import("cf/config").InferEnv<Worker>;
}
