import { sign } from "node:crypto";
import { Buffer } from "node:buffer";

export function appJwt(clientId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}
