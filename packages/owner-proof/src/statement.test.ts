import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonical, keyIdOf, keyRing, verifySigned, type KeyRing, type ProofInput, type StatementKind } from "./statement.js";

const NOW = 1_791_500_100;
const AUD = "basement";

const NoteSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("test.note"),
  aud: z.string().min(1),
  keyId: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  note: z.string(),
});
type Note = z.infer<typeof NoteSchema>;

const NOTE: StatementKind<Note, "vetoed"> = { schema: NoteSchema, refusal: (s) => (s.note === "veto" ? "vetoed" : undefined) };

const newKey = (namedCurve = "P-256") => generateKeyPairSync("ec", { namedCurve });

function noteFor(publicKey: KeyObject, over: Partial<Note> = {}): Note {
  return { v: 1, type: "test.note", aud: AUD, keyId: keyIdOf(publicKey), iat: NOW - 10, exp: NOW + 110, note: "hello", ...over };
}

function proofFrom(privateKey: KeyObject, statement: unknown): ProofInput {
  const bytes = Buffer.from(typeof statement === "string" ? statement : JSON.stringify(statement));
  const signature = sign("sha256", bytes, { key: privateKey, dsaEncoding: "der" });
  return { statementB64: bytes.toString("base64url"), signatureB64: signature.toString("base64url") };
}

function setup(): { publicKey: KeyObject; privateKey: KeyObject; keys: KeyRing } {
  const { publicKey, privateKey } = newKey();
  return { publicKey, privateKey, keys: keyRing([publicKey]) };
}

function refusalOf(proof: ProofInput, keys: KeyRing, now = NOW): string {
  const result = verifySigned(proof, keys, now, AUD, NOTE);
  return result.ok ? "accepted" : result.refusal;
}

function flip(b64: string, at: number): string {
  const bytes = Buffer.from(b64, "base64url");
  bytes[at] = (bytes[at] ?? 0) ^ 1;
  return bytes.toString("base64url");
}

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

function derInt(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = Buffer.from(hex, "hex");
  const body = (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}

/** Re-encodes a DER signature with s replaced by n - s, which is a different byte string that verifies just the same. */
function flipS(signatureB64: string): string {
  const raw = Buffer.from(signatureB64, "base64url");
  const r = BigInt(`0x${raw.subarray(4, 4 + (raw[3] ?? 0)).toString("hex")}`);
  const sAt = 4 + (raw[3] ?? 0);
  const s = BigInt(`0x${raw.subarray(sAt + 2, sAt + 2 + (raw[sAt + 1] ?? 0)).toString("hex")}`);
  const body = Buffer.concat([derInt(r), derInt(P256_ORDER - s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString("base64url");
}

describe("verifySigned", () => {
  it("accepts a valid statement and returns it with the signer's key id", () => {
    const { publicKey, privateKey, keys } = setup();
    const statement = noteFor(publicKey);
    expect(verifySigned(proofFrom(privateKey, statement), keys, NOW, AUD, NOTE)).toEqual({ ok: true, statement, keyId: keyIdOf(publicKey) });
  });

  it("refuses statement bytes flipped after signing as a bad signature, before parsing them", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, noteFor(publicKey));
    expect(refusalOf({ ...proof, statementB64: flip(proof.statementB64, 20) }, keys)).toBe("bad-signature");
  });

  it("refuses a flipped byte in the signature", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, noteFor(publicKey));
    expect(refusalOf({ ...proof, signatureB64: flip(proof.signatureB64, 10) }, keys)).toBe("bad-signature");
  });

  it("refuses a signature from a key outside the ring, even when the statement names that key", () => {
    const { keys } = setup();
    const other = newKey();
    expect(refusalOf(proofFrom(other.privateKey, noteFor(other.publicKey)), keys)).toBe("bad-signature");
  });

  it("refuses every statement when the ring is empty", () => {
    const { publicKey, privateKey } = setup();
    expect(refusalOf(proofFrom(privateKey, noteFor(publicKey)), keyRing([]))).toBe("unknown-key");
  });

  it("refuses a validly signed statement that names another key id", () => {
    const { publicKey, privateKey, keys } = setup();
    expect(refusalOf(proofFrom(privateKey, noteFor(publicKey, { keyId: "0".repeat(16) })), keys)).toBe("unknown-key");
  });

  it("refuses a statement more than 30 s past its expiry and accepts one at exactly 30 s", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, noteFor(publicKey, { iat: NOW - 200, exp: NOW - 31 }));
    expect(refusalOf(proof, keys)).toBe("expired");
    expect(refusalOf(proof, keys, NOW - 1)).toBe("accepted");
  });

  it("refuses a statement issued more than 60 s in the future", () => {
    const { publicKey, privateKey, keys } = setup();
    expect(refusalOf(proofFrom(privateKey, noteFor(publicKey, { iat: NOW + 61, exp: NOW + 161 })), keys)).toBe("not-yet-valid");
  });

  it("refuses a window of 301 s and accepts one of 300 s", () => {
    const { publicKey, privateKey, keys } = setup();
    expect(refusalOf(proofFrom(privateKey, noteFor(publicKey, { iat: NOW - 10, exp: NOW + 291 })), keys)).toBe("window-too-long");
    expect(refusalOf(proofFrom(privateKey, noteFor(publicKey, { iat: NOW - 10, exp: NOW + 290 })), keys)).toBe("accepted");
  });

  it("refuses an expiry that is not after issue", () => {
    const { publicKey, privateKey, keys } = setup();
    expect(refusalOf(proofFrom(privateKey, noteFor(publicKey, { iat: NOW, exp: NOW })), keys)).toBe("malformed");
  });

  it("refuses a statement for another audience", () => {
    const { publicKey, privateKey, keys } = setup();
    expect(refusalOf(proofFrom(privateKey, noteFor(publicKey, { aud: "elsewhere" })), keys)).toBe("wrong-aud");
  });

  it("returns the kind's own refusal once the envelope passes", () => {
    const { publicKey, privateKey, keys } = setup();
    expect(refusalOf(proofFrom(privateKey, noteFor(publicKey, { note: "veto" })), keys)).toBe("vetoed");
  });

  it("refuses a signed statement of another type as malformed", () => {
    const { publicKey, privateKey, keys } = setup();
    const other = { ...noteFor(publicKey), type: "titan-factory.gate-resolve" };
    expect(refusalOf(proofFrom(privateKey, other), keys)).toBe("malformed");
  });

  it("still verifies a high-S re-encoding of a signature, so callers must dedupe on the nonce", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, noteFor(publicKey));
    const reencoded = { ...proof, signatureB64: flipS(proof.signatureB64) };
    expect(reencoded.signatureB64).not.toBe(proof.signatureB64);
    expect(refusalOf(reencoded, keys)).toBe("accepted");
  });

  it("refuses a raw r||s signature that is not DER", () => {
    const { publicKey, privateKey, keys } = setup();
    const bytes = Buffer.from(JSON.stringify(noteFor(publicKey)));
    const raw = sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" });
    expect(refusalOf({ statementB64: bytes.toString("base64url"), signatureB64: raw.toString("base64url") }, keys)).toBe("bad-signature");
  });

  it.each([
    ["statement base64", { statementB64: "***", signatureB64: "AA" }],
    ["signature base64", { statementB64: "AA", signatureB64: "not base64!" }],
    ["empty statement", { statementB64: "", signatureB64: "AA" }],
    ["padded base64", { statementB64: "AA==", signatureB64: "AA" }],
  ])("refuses malformed %s without throwing", (_name, proof) => {
    expect(refusalOf(proof, setup().keys)).toBe("malformed");
  });

  it("refuses a non-JSON signed statement as malformed", () => {
    const { privateKey, keys } = setup();
    expect(refusalOf(proofFrom(privateKey, "not json"), keys)).toBe("malformed");
  });
});

describe("keyRing", () => {
  it("throws on a key that is not ECDSA P-256", () => {
    expect(() => keyRing([newKey("P-384").publicKey])).toThrow(/P-256/);
  });

  it("indexes a PEM key under its key id", () => {
    const { publicKey } = newKey();
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect([...keyRing([pem]).keys()]).toEqual([keyIdOf(publicKey)]);
  });
});

describe("canonical", () => {
  it("gives the same text whatever order the keys were written in", () => {
    expect(canonical({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonical({ a: { c: null, d: [1, 2] }, b: 1 }));
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("throws past 32 levels of nesting", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 34; i += 1) deep = [deep];
    expect(() => canonical(deep)).toThrow(RangeError);
  });
});
