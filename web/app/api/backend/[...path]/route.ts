import { NextRequest, NextResponse } from "next/server";

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const valid = path.length === 1 && ["runs", "health"].includes(path[0]) ||
    path.length === 2 && path[0] === "runs" && /^[a-f0-9-]+$/.test(path[1]);
  if (!valid) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const base = process.env.VULTR_BACKEND_URL;
  const token = process.env.VULTR_BACKEND_TOKEN;
  if (!base || !token) return NextResponse.json({ error: "Vultr backend is not configured" }, { status: 503 });
  try {
    const upstream = await fetch(new URL("/" + path.join("/"), base), {
      method: request.method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: request.method === "POST" ? await request.text() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Vultr backend is unreachable" }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
