import JSON5 from "json5";

export class CloudflareError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const base = "https://api.cloudflare.com/client/v4";
const encoder = new TextEncoder();
type ConnectionDb = { prepare(sql: string): { bind(...values: (string | number | null)[]): {
  first<T>(): Promise<T | null>; run(): Promise<{ meta: { changes: number } }> } } };
export type CloudflareConnection = { account_id: string; cloudflare_account_id: string;
  token_ciphertext: string; auth_method: "token" | "oauth";
  refresh_ciphertext: string | null; token_expires_at: number | null };

export async function connectionFor(db: ConnectionDb, accountId: string) {
  return db.prepare("SELECT account_id, cloudflare_account_id, token_ciphertext, auth_method, refresh_ciphertext, token_expires_at FROM cloudflare_connections WHERE account_id = ?")
    .bind(accountId).first<CloudflareConnection>();
}

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

export async function cloudflareToken(db: ConnectionDb, connection: CloudflareConnection): Promise<string> {
  if (connection.auth_method === "token") return decryptToken(connection.token_ciphertext);
  if (connection.token_expires_at && connection.token_expires_at > Date.now() + 60_000)
    return decryptToken(connection.token_ciphertext);
  const clientId = process.env.CLOUDFLARE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret || !connection.refresh_ciphertext)
    throw new CloudflareError(503, "Cloudflare OAuth connection needs to be reconnected");
  const refreshToken = await decryptToken(connection.refresh_ciphertext);
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST", headers: { Authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`,
      "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token",
      refresh_token: refreshToken }), cache: "no-store",
  });
  const payload = await response.json().catch(() => null) as { access_token?: string;
    refresh_token?: string; expires_in?: number } | null;
  if (!response.ok || !payload?.access_token ||
    !Number.isFinite(payload.expires_in) || payload.expires_in! <= 0) {
    const latest = await connectionFor(db, connection.account_id);
    if (latest?.auth_method === "oauth" && latest.token_ciphertext !== connection.token_ciphertext)
      return cloudflareToken(db, latest);
    throw new CloudflareError(503, "Cloudflare OAuth connection needs to be reconnected");
  }
  const changed = await db.prepare("UPDATE cloudflare_connections SET token_ciphertext = ?, refresh_ciphertext = ?, token_expires_at = ? WHERE account_id = ? AND token_ciphertext = ? AND auth_method = 'oauth'")
    .bind(await encryptToken(payload.access_token), await encryptToken(payload.refresh_token || refreshToken),
      Date.now() + payload.expires_in! * 1000, connection.account_id, connection.token_ciphertext).run();
  if (changed.meta.changes === 1) return payload.access_token;
  const latest = await connectionFor(db, connection.account_id);
  if (!latest || latest.auth_method !== "oauth" || latest.token_ciphertext === connection.token_ciphertext)
    throw new CloudflareError(503, "Cloudflare connection changed; retry");
  return cloudflareToken(db, latest);
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
  vars?: Record<string, unknown>; define?: Record<string, unknown>; worker_loaders?: Binding[] };

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
  if (config.define && (Array.isArray(config.define) || typeof config.previews.define !== "object" ||
    !config.previews.define || Array.isArray(config.previews.define) ||
    Object.keys(config.define).some(key => !Object.hasOwn(config.previews!.define!, key))))
    throw new CloudflareError(400, "Add Preview define values for the production names");
  for (const kind of ["ai", "browser", "images", "stream", "media", "version_metadata"] as const) {
    const production = (config as Record<string, unknown>)[kind] as Binding | undefined;
    if (!production) continue;
    const preview = config.previews[kind] as Binding | undefined;
    if (typeof production.binding !== "string" || !production.binding || preview?.binding !== production.binding)
      throw new CloudflareError(400, `Add a Preview ${kind} binding named ${String(production.binding)}`);
  }
  if (config.worker_loaders && (!Array.isArray(config.worker_loaders) ||
    !Array.isArray(config.previews.worker_loaders) || config.worker_loaders.some(binding =>
      !(config.previews!.worker_loaders as Binding[]).some(item => item.binding === binding.binding))))
    throw new CloudflareError(400, "Add Preview Worker Loader bindings for the production names");
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

export type BuildTrigger = { trigger_uuid: string; repo_connection_uuid?: string; build_token_uuid?: string;
  repo_connection?: { provider_type?: string; repo_id?: string };
  build_command?: string; deploy_command?: string; root_directory?: string;
  branch_includes?: string[]; branch_excludes?: string[]; path_includes?: string[]; path_excludes?: string[] };

export function verifyWorkerRepository(triggers: BuildTrigger[], connectionUuid: string) {
  if (triggers.some(trigger => trigger.repo_connection_uuid !== connectionUuid))
    throw new CloudflareError(409, "This Worker already has Builds connected to another repository");
}

export function productionTrigger(triggers: BuildTrigger[], branch: string, repoId: number,
  connectionUuid?: string) {
  return triggers.find(item => item.branch_includes?.includes(branch) &&
    !item.branch_excludes?.includes(branch) && (connectionUuid
      ? item.repo_connection_uuid === connectionUuid
      : item.repo_connection?.provider_type === "github" && item.repo_connection.repo_id === String(repoId)));
}

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
      url: build.build_outcome === "success" && build.preview_url?.startsWith("https://") ? build.preview_url : null }));
}
