import { GitHubError } from "./fava-github.ts";

export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new GitHubError(413, "Request body is too large");
  const reader = request.body?.getReader();
  if (!reader) throw new GitHubError(400, "Invalid JSON body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new GitHubError(413, "Request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new GitHubError(400, "Invalid JSON body"); }
}
