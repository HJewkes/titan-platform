import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/** The `X-Hub-Signature-256` value GitHub sends for these exact bytes; the harness signs with this so it cannot drift from the route. */
export function signDelivery(secret: string, body: Uint8Array): string {
  return PREFIX + createHmac("sha256", secret).update(body).digest("hex");
}

/** Over the raw bytes, never a re-serialised parse. A header of the wrong length or scheme is a mismatch, not a throw. */
export function verifySignature(secret: string, raw: Uint8Array, header: string): boolean {
  const expected = Buffer.from(signDelivery(secret, raw));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
