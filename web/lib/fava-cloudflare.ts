import JSON5 from "json5";

export class CloudflareError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const base = "https://api.cloudflare.com/client/v4";
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
}

async function key(purpose: "cloudflare" | "mcp", secret = process.env.FAVA_SESSION_SECRET) {
  if (!secret || secret.length < 32) throw new CloudflareError(503, "Fava credential encryption is not configured");
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`fava:${purpose}:${secret}`));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(token: string, purpose: "cloudflare" | "mcp" = "cloudflare", secret?: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(purpose, secret), encoder.encode(token));
  return `${base64url(iv)}.${base64url(new Uint8Array(data))}`;
}

export async function decryptToken(value: string, purpose: "cloudflare" | "mcp" = "cloudflare", secret?: string) {
  try {
    const [iv, data] = value.split(".");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv) }, await key(purpose, secret), fromBase64url(data));
    return new TextDecoder().decode(plain);
  } catch { throw new CloudflareError(503, purpose === "mcp" ? "MCP connection needs to be reconnected" : "Cloudflare connection needs to be reconnected"); }
}

export async function cloudflare<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const payload = await response.json().catch(() => null) as { success?: boolean; result?: T;
    errors?: { message?: string }[] } | null;
  if (!response.ok || !payload?.success)
    throw new CloudflareError(response.status === 401 || response.status === 403 ? 403 : 502,
      payload?.errors?.[0]?.message || "Cloudflare request failed");
  return payload.result as T;
}

type Binding = Record<string, unknown>;
type WranglerConfig = { name?: string; previews?: Record<string, unknown>;
  d1_databases?: Binding[]; r2_buckets?: Binding[]; kv_namespaces?: Binding[];
  durable_objects?: { bindings?: Binding[] }; queues?: { producers?: Binding[] }; containers?: Binding[];
  vars?: Record<string, unknown> };

export function wranglerConfigPaths(rootDirectory: string) {
  const root = rootDirectory.replace(/^(?:\.\/|\/)|\/$/g, "");
  const segments = root ? root.split("/") : [];
  if (segments.some(segment => !segment || segment === "." || segment === ".."))
    throw new CloudflareError(400, "Worker Builds root directory is invalid");
  return ["wrangler.jsonc", "wrangler.json"].map(file =>
    [...segments, file].map(encodeURIComponent).join("/"));
}

export function verifyPreviewConfig(source: string, workerName: string) {
  let config: WranglerConfig;
  try { config = JSON5.parse(source) as WranglerConfig; }
  catch { throw new CloudflareError(400, "Wrangler configuration is not valid JSON or JSONC"); }
  if (config.name !== workerName) throw new CloudflareError(400, "Wrangler Worker name must match the selected Cloudflare Worker");
  if (!config.previews || typeof config.previews !== "object" || Array.isArray(config.previews))
    throw new CloudflareError(400, "Add a previews block to wrangler.json or wrangler.jsonc first");
  for (const [kind, identity] of [["d1_databases", "database_id"], ["r2_buckets", "bucket_name"],
    ["kv_namespaces", "id"], ["vectorize", "index_name"], ["hyperdrive", "id"],
    ["analytics_engine_datasets", "dataset"], ["pipelines", "stream"],
    ["workflows", "name"], ["dispatch_namespaces", "namespace"],
    ["mtls_certificates", "certificate_id"], ["vpc_services", "service_id"],
    ["services", "service"], ["ratelimits", "namespace_id"]] as const) {
    const production = (config as Record<string, unknown>)[kind] || [];
    const preview = config.previews[kind] as Binding[] | undefined || [];
    if (!Array.isArray(production) || !Array.isArray(preview)) throw new CloudflareError(400, `Invalid ${kind} bindings`);
    for (const binding of production) {
      const key = kind === "ratelimits" ? "name" : "binding";
      const same = preview.find(item => item[key] === binding[key]);
      const previewId = kind === "pipelines" ? same?.stream || same?.pipeline : same?.[identity];
      const productionId = kind === "pipelines" ? binding.stream || binding.pipeline : binding[identity];
      if (typeof previewId !== "string" || !previewId)
        throw new CloudflareError(400, `Add an isolated Preview ${kind} binding for ${String(binding[key])}`);
      if (previewId === productionId)
        throw new CloudflareError(400, `Preview ${kind} must use a different resource from Production`);
    }
  }
  const productionQueues = config.queues?.producers || [];
  const previewQueues = (config.previews.queues as { producers?: Binding[] } | undefined)?.producers || [];
  if (!Array.isArray(productionQueues) || !Array.isArray(previewQueues))
    throw new CloudflareError(400, "Invalid Queue producer bindings");
  for (const binding of productionQueues) {
    const same = previewQueues.find(item => item.binding === binding.binding);
    if (!same?.queue || typeof same.queue !== "string" || same.queue === binding.queue)
      throw new CloudflareError(400, `Add an isolated Preview Queue for ${String(binding.binding)}`);
  }
  const productionSecrets = (config as Record<string, unknown>).secrets_store_secrets || [];
  const previewSecrets = config.previews.secrets_store_secrets || [];
  if (!Array.isArray(productionSecrets) || !Array.isArray(previewSecrets))
    throw new CloudflareError(400, "Invalid Secrets Store bindings");
  for (const binding of productionSecrets) {
    const same = previewSecrets.find(item => item.binding === binding.binding);
    if (!same || typeof same.store_id !== "string" || typeof same.secret_name !== "string" ||
      same.store_id === binding.store_id && same.secret_name === binding.secret_name)
      throw new CloudflareError(400, `Add an isolated Preview secret for ${String(binding.binding)}`);
  }
  const productionContainers = config.containers || [];
  const previewContainers = config.previews.containers as Binding[] | undefined || [];
  if (!Array.isArray(productionContainers) || !Array.isArray(previewContainers))
    throw new CloudflareError(400, "Invalid Container bindings");
  for (const container of productionContainers)
    if (!previewContainers.some(item => item.class_name === container.class_name))
      throw new CloudflareError(400, `Add a Preview Container for ${String(container.class_name)}`);
  if (config.vars && (Array.isArray(config.vars) || typeof config.previews.vars !== "object" ||
    !config.previews.vars || Array.isArray(config.previews.vars) ||
    Object.keys(config.vars).some(key => !Object.hasOwn(config.previews!.vars!, key))))
    throw new CloudflareError(400, "Add Preview variables for the production variable names");
  const productionObjects = config.durable_objects?.bindings || [];
  const previewObjects = (config.previews.durable_objects as { bindings?: Binding[] } | undefined)?.bindings || [];
  if (!Array.isArray(productionObjects) || !Array.isArray(previewObjects))
    throw new CloudflareError(400, "Invalid Durable Object bindings");
  for (const binding of productionObjects)
    if (!previewObjects.some(item => item.name === binding.name && item.class_name === binding.class_name))
      throw new CloudflareError(400, `Add a Preview Durable Object binding for ${String(binding.name)}`);
  return config;
}

export type PreviewBuild = { build_uuid: string; created_on?: string; status?: string; build_outcome?: string;
  preview_url?: string; build_trigger_metadata?: { branch?: string; commit_hash?: string };
  trigger?: { trigger_uuid?: string } };

export function recentPreviewBuilds(builds: PreviewBuild[], triggerUuid: string) {
  const branches = new Set<string>();
  return builds.filter(build => build.trigger?.trigger_uuid === triggerUuid && build.build_trigger_metadata?.branch)
    .sort((a, b) => (b.created_on || "").localeCompare(a.created_on || ""))
    .filter(build => { const branch = build.build_trigger_metadata!.branch!;
      if (branches.has(branch)) return false;
      branches.add(branch); return true; })
    .slice(0, 5)
    .map(build => ({ branch: build.build_trigger_metadata!.branch!, buildUuid: build.build_uuid,
      status: build.status || "unknown", outcome: build.build_outcome || null,
      url: build.preview_url?.startsWith("https://") ? build.preview_url : null }));
}
