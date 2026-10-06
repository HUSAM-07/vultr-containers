import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

function session(request: NextRequest, token: string) {
  const cookie = request.cookies.get("forge_session")?.value || "";
  const [id, signature] = cookie.split(".");
  if (id && /^[a-f0-9-]{36}$/.test(id) && signature && /^[a-f0-9]{64}$/.test(signature)) {
    const expected = createHmac("sha256", token).update(id).digest("hex");
    if (timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return { id, fresh: false };
  }
  return { id: randomUUID(), fresh: true };
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const valid = path.length === 1 && ["runs", "health"].includes(path[0]) ||
    path.length === 2 && path[0] === "runs" && /^[a-f0-9-]+$/.test(path[1]);
  if (!valid) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const base = process.env.VULTR_BACKEND_URL;
  const token = process.env.VULTR_BACKEND_TOKEN;
  if (!base || !token) return NextResponse.json({ error: "Vultr backend is not configured" }, { status: 503 });
  const visitor = session(request, token);
  try {
    const upstream = await fetch(new URL("/" + path.join("/"), base), {
      method: request.method,
      headers: { Authorization: "Bearer " + token, "X-Session-Id": visitor.id, "Content-Type": "application/json" },
      body: request.method === "POST" ? await request.text() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const response = new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
    if (visitor.fresh) response.cookies.set("forge_session",
      visitor.id + "." + createHmac("sha256", token).update(visitor.id).digest("hex"),
      { httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:", path: "/" });
    return response;
  } catch {
    return NextResponse.json({ error: "Vultr backend is unreachable" }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
