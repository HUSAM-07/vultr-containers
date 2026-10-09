import { createHmac, timingSafeEqual } from "node:crypto";

const idPattern = /^[a-f0-9-]{36}$/;

export function runCapability(id: string, secret: string) {
  if (!idPattern.test(id) || secret.length < 32) throw Error("Invalid run capability configuration");
  return `${id}.${createHmac("sha256", secret).update(id).digest("hex")}`;
}

export function readRunCapability(value: string | null, secret: string) {
  if (!value) return null;
  const id = value.slice(0, 36);
  const signature = value.slice(37);
  if (!idPattern.test(id) || value[36] !== "." || !/^[a-f0-9]{64}$/.test(signature) || secret.length < 32)
    return null;
  const expected = createHmac("sha256", secret).update(id).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex")) ? id : null;
}
