import { describe, expect, it } from "vitest";
import { signDelivery, verifySignature } from "./signature.js";

const SECRET = "synthetic-test-secret";
const bytes = (text: string): Uint8Array => Buffer.from(text, "utf8");

describe("webhook signature", () => {
  // Mutation killed: signDelivery and verifySignature both switched to SHA-1 (self-consistent, but not GitHub's scheme).
  it("matches the HMAC test vector in GitHub's 'Validating webhook deliveries' guide", () => {
    expect(signDelivery("It's a Secret to Everybody", bytes("Hello, World!"))).toBe("sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");
  });

  // Mutation killed: verifying against JSON.stringify(JSON.parse(raw)) instead of the raw bytes.
  it("verifies a body with insignificant whitespace over its exact bytes and refuses one flipped byte", () => {
    const raw = bytes('{ "zen" :  "Keep it logically awesome." ,\n  "hook_id": 1 }\n');
    const header = signDelivery(SECRET, raw);
    const flipped = Uint8Array.from(raw);
    flipped[3] = (flipped[3] ?? 0) ^ 1;

    expect(verifySignature(SECRET, raw, header)).toBe(true);
    expect(verifySignature(SECRET, flipped, header)).toBe(false);
  });

  it("refuses a sha1 header, a short hex and an empty header without throwing", () => {
    const raw = bytes('{"a":1}');
    const hex = signDelivery(SECRET, raw).slice("sha256=".length);

    expect(verifySignature(SECRET, raw, `sha1=${hex.slice(0, 40)}`)).toBe(false);
    expect(verifySignature(SECRET, raw, "sha256=abcd")).toBe(false);
    expect(verifySignature(SECRET, raw, "")).toBe(false);
  });

  // Mutation killed: timingSafeEqual called without the length guard, which throws RangeError on unequal lengths.
  it("returns false for a 63-hex-char signature rather than throwing", () => {
    const raw = bytes('{"a":1}');
    const short = signDelivery(SECRET, raw).slice(0, -1);

    expect(() => verifySignature(SECRET, raw, short)).not.toThrow();
    expect(verifySignature(SECRET, raw, short)).toBe(false);
  });
});
