import type { NextRequest, NextResponse } from "next/server";
import type { env } from "./runtime-env.ts";

export type FavaSession = {
  id: string;
  token: string;
  expiresAt: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
  user: { id: number; login: string; avatarUrl: string };
};

const cookieName = "fava_session";
const encoder = new TextEncoder();
type Db = typeof env.DB;

async function idHash(id: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(id))),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

function deadline(session: FavaSession) {
  return Math.min(session.refreshExpiresAt || session.expiresAt, Date.now() + 30 * 24 * 60 * 60 * 1000);
}

export async function createSession(db: Db, session: FavaSession) {
  await db.prepare("INSERT INTO sessions (id_hash, github_id, expires_at) VALUES (?, ?, ?)")
    .bind(await idHash(session.id), session.user.id, deadline(session)).run();
}

export async function revokeSession(db: Db, request: NextRequest) {
  const session = await unseal(request.cookies.get(cookieName)?.value);
  if (session) await db.prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND github_id = ?")
    .bind(Date.now(), await idHash(session.id), session.user.id).run();
}

function secret() {
  const value = process.env.FAVA_SESSION_SECRET;
  if (!value || value.length < 32) throw Error("FAVA_SESSION_SECRET must be at least 32 characters");
  return value;
}

function bytes(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
}

function base64url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function key() {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret()));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(session: FavaSession) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), encoder.encode(JSON.stringify(session)));
  return base64url(iv) + "." + base64url(new Uint8Array(encrypted));
}

export async function unseal(value?: string): Promise<FavaSession | null> {
  if (!value) return null;
  try {
    const [iv, encrypted] = value.split(".");
    if (!iv || !encrypted) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv) }, await key(), bytes(encrypted));
    const session = JSON.parse(new TextDecoder().decode(plain)) as FavaSession;
    return typeof session.id === "string" && /^[a-f0-9-]{36}$/i.test(session.id) &&
      typeof session.token === "string" && Number.isFinite(session.expiresAt) &&
      typeof session.user?.id === "number" ? session : null;
  } catch { return null; }
}

export async function readSession(request: NextRequest, db: Db) {
  const session = await unseal(request.cookies.get(cookieName)?.value);
  if (!session) return null;
  const hash = await idHash(session.id);
  const active = await db.prepare("SELECT 1 AS active FROM sessions WHERE id_hash = ? AND github_id = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(hash, session.user.id, Date.now()).first();
  if (!active) return null;
  if (session.expiresAt > Date.now() + 60_000) return { session, refreshed: false };
  if (!session.refreshToken || !session.refreshExpiresAt || session.refreshExpiresAt <= Date.now()) return null;
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
      grant_type: "refresh_token", refresh_token: session.refreshToken }),
    cache: "no-store",
  });
  if (!response.ok) return null;
  const value = await response.json();
  if (typeof value.access_token !== "string" || typeof value.expires_in !== "number") return null;
  const renewed = { ...session, token: value.access_token, expiresAt: Date.now() + value.expires_in * 1000,
    refreshToken: value.refresh_token || session.refreshToken,
    refreshExpiresAt: value.refresh_token_expires_in ? Date.now() + value.refresh_token_expires_in * 1000 : session.refreshExpiresAt };
  const updated = await db.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ? AND revoked_at IS NULL")
    .bind(deadline(renewed), hash).run();
  return updated.meta.changes === 1 ? { session: renewed, refreshed: true } : null;
}

export async function setSession(response: NextResponse, request: NextRequest, session: FavaSession) {
  response.cookies.set(cookieName, await seal(session), { httpOnly: true, secure: request.nextUrl.protocol === "https:",
    sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
}

export function clearSession(response: NextResponse) {
  response.cookies.set(cookieName, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}
