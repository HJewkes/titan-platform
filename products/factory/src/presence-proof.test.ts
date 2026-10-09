import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { itemsDigest, keyIdOf, keyRing, verifyProof, type ProofItem, type Statement } from "./presence-proof.js";

const NOW = 1_791_500_100;
const AUD = "basement";
const HEAD = "a".repeat(40);

const item = (over: Partial<ProofItem> = {}): ProofItem => ({
  gate: "run/merge:1",
  runId: "run",
  stepId: "merge",
  repo: "owner/repo",
  pr: 837,
  headSha: HEAD,
  payload: { decision: "merge", headSha: HEAD },
  ...over,
});

const newKey = (namedCurve = "P-256") => generateKeyPairSync("ec", { namedCurve });
const keyIdFor = (publicKey: KeyObject): string => keyIdOf(publicKey);

function statementFor(publicKey: KeyObject, over: Partial<Statement> = {}, items: ProofItem[] = [item()]): Statement {
  return {
    v: 1,
    type: "titan-factory.gate-resolve",
    aud: AUD,
    keyId: keyIdFor(publicKey),
    nonce: "0123456789abcdef0123456789abcdef",
    iat: NOW - 10,
    exp: NOW + 110,
    digest: itemsDigest(items),
    items,
    ...over,
  };
}

function proofFrom(privateKey: KeyObject, statement: unknown) {
  const bytes = Buffer.from(typeof statement === "string" ? statement : JSON.stringify(statement));
  const signature = sign("sha256", bytes, { key: privateKey, dsaEncoding: "der" });
  return { statementB64: bytes.toString("base64url"), signatureB64: signature.toString("base64url") };
}

function setup() {
  const { publicKey, privateKey } = newKey();
  return { publicKey, privateKey, keys: keyRing([publicKey]) };
}

const refusal = (result: ReturnType<typeof verifyProof>) => (result.ok ? "accepted" : result.refusal);

function flip(b64: string, at: number): string {
  const bytes = Buffer.from(b64, "base64url");
  bytes[at] = (bytes[at] ?? 0) ^ 1;
  return bytes.toString("base64url");
}

describe("verifyProof", () => {
  it("accepts a valid single-item proof and returns the statement and key id", () => {
    const { publicKey, privateKey, keys } = setup();
    const statement = statementFor(publicKey);
    const result = verifyProof(proofFrom(privateKey, statement), keys, NOW, AUD);
    expect(result).toEqual({ ok: true, statement, keyId: keyIdFor(publicKey) });
  });

  it("accepts a multi-item proof of plain merge gates", () => {
    const { publicKey, privateKey, keys } = setup();
    const items = [item(), item({ gate: "run2/merge:1", runId: "run2" })];
    expect(refusal(verifyProof(proofFrom(privateKey, statementFor(publicKey, {}, items)), keys, NOW, AUD))).toBe("accepted");
  });

  it("refuses one flipped byte in the statement", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, statementFor(publicKey));
    expect(refusal(verifyProof({ ...proof, statementB64: flip(proof.statementB64, 20) }, keys, NOW, AUD))).toBe("bad-signature");
  });

  it("refuses one flipped byte in the signature", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, statementFor(publicKey));
    expect(refusal(verifyProof({ ...proof, signatureB64: flip(proof.signatureB64, 10) }, keys, NOW, AUD))).toBe("bad-signature");
  });

  it("refuses a signature from a key that is not installed", () => {
    const { publicKey, keys } = setup();
    const other = newKey();
    const proof = proofFrom(other.privateKey, statementFor(publicKey));
    expect(refusal(verifyProof(proof, keys, NOW, AUD))).toBe("bad-signature");
  });

  it("refuses when no key is installed", () => {
    const { publicKey, privateKey } = setup();
    expect(refusal(verifyProof(proofFrom(privateKey, statementFor(publicKey)), keyRing([]), NOW, AUD))).toBe("unknown-key");
  });

  it("refuses a validly signed statement that names another key id", () => {
    const { publicKey, privateKey, keys } = setup();
    const statement = statementFor(publicKey, { keyId: "0".repeat(16) });
    expect(refusal(verifyProof(proofFrom(privateKey, statement), keys, NOW, AUD))).toBe("unknown-key");
  });

  it("refuses an expired statement past the skew allowance", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, statementFor(publicKey, { iat: NOW - 200, exp: NOW - 31 }));
    expect(refusal(verifyProof(proof, keys, NOW, AUD))).toBe("expired");
  });

  it("accepts a statement that expired inside the skew allowance", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, statementFor(publicKey, { iat: NOW - 200, exp: NOW - 30 }));
    expect(refusal(verifyProof(proof, keys, NOW, AUD))).toBe("accepted");
  });

  it("refuses a statement issued in the future", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, statementFor(publicKey, { iat: NOW + 61, exp: NOW + 161 }));
    expect(refusal(verifyProof(proof, keys, NOW, AUD))).toBe("not-yet-valid");
  });

  it("refuses a window longer than 300 seconds", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, statementFor(publicKey, { iat: NOW - 10, exp: NOW + 291 }));
    expect(refusal(verifyProof(proof, keys, NOW, AUD))).toBe("window-too-long");
  });

  it("refuses an expiry that is not after issue", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, statementFor(publicKey, { iat: NOW, exp: NOW }));
    expect(refusal(verifyProof(proof, keys, NOW, AUD))).toBe("malformed");
  });

  it("refuses a statement for another audience", () => {
    const { publicKey, privateKey, keys } = setup();
    const proof = proofFrom(privateKey, statementFor(publicKey, { aud: "elsewhere" }));
    expect(refusal(verifyProof(proof, keys, NOW, AUD))).toBe("wrong-aud");
  });

  it("refuses items that do not match the signed digest", () => {
    const { publicKey, privateKey, keys } = setup();
    const statement = statementFor(publicKey);
    const tampered = { ...statement, items: [item({ headSha: "b".repeat(40) })] };
    expect(refusal(verifyProof(proofFrom(privateKey, tampered), keys, NOW, AUD))).toBe("digest-mismatch");
  });

  it.each(["after-stages", "device-flash", "hardware-check"])("refuses a multi-item statement containing the %s gate", (stepId) => {
    const { publicKey, privateKey, keys } = setup();
    const items = [item(), item({ gate: `run2/${stepId}`, runId: "run2", stepId })];
    expect(refusal(verifyProof(proofFrom(privateKey, statementFor(publicKey, {}, items)), keys, NOW, AUD))).toBe("mixed-release-batch");
  });

  it("accepts a single release item", () => {
    const { publicKey, privateKey, keys } = setup();
    const items = [item({ gate: "run/after-stages", stepId: "after-stages", payload: { decision: "release" } })];
    expect(refusal(verifyProof(proofFrom(privateKey, statementFor(publicKey, {}, items)), keys, NOW, AUD))).toBe("accepted");
  });

  it("refuses a raw r||s signature that is not DER", () => {
    const { publicKey, privateKey, keys } = setup();
    const statement = statementFor(publicKey);
    const bytes = Buffer.from(JSON.stringify(statement));
    const raw = sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" });
    const proof = { statementB64: bytes.toString("base64url"), signatureB64: raw.toString("base64url") };
    expect(refusal(verifyProof(proof, keys, NOW, AUD))).toBe("bad-signature");
  });

  it("refuses a P-384 signature", () => {
    const { publicKey, keys } = setup();
    const wrong = newKey("P-384");
    expect(refusal(verifyProof(proofFrom(wrong.privateKey, statementFor(publicKey)), keys, NOW, AUD))).toBe("bad-signature");
  });

  it("does not let a P-384 key into the key ring", () => {
    expect(() => keyRing([newKey("P-384").publicKey])).toThrow(/P-256/);
  });

  it.each([
    ["statement base64", { statementB64: "***", signatureB64: "AA" }],
    ["signature base64", { statementB64: "AA", signatureB64: "not base64!" }],
    ["empty statement", { statementB64: "", signatureB64: "AA" }],
    ["padded base64", { statementB64: "AA==", signatureB64: "AA" }],
  ])("refuses malformed %s without throwing", (_name, proof) => {
    const { keys } = setup();
    expect(refusal(verifyProof(proof, keys, NOW, AUD))).toBe("malformed");
  });

  it.each([
    ["non-JSON", "not json"],
    ["a JSON array", "[]"],
    ["an unknown field", JSON.stringify({ extra: 1 })],
  ])("refuses a signed statement that is %s", (_name, text) => {
    const { privateKey, keys } = setup();
    expect(refusal(verifyProof(proofFrom(privateKey, text), keys, NOW, AUD))).toBe("malformed");
  });

  it("refuses a signed statement with an extra field", () => {
    const { publicKey, privateKey, keys } = setup();
    const statement = { ...statementFor(publicKey), extra: true };
    expect(refusal(verifyProof(proofFrom(privateKey, statement), keys, NOW, AUD))).toBe("malformed");
  });

  it("refuses a signed statement with no items", () => {
    const { publicKey, privateKey, keys } = setup();
    expect(refusal(verifyProof(proofFrom(privateKey, statementFor(publicKey, {}, [])), keys, NOW, AUD))).toBe("malformed");
  });

  it("refuses the probe where a release gate claims a plain step id", () => {
    const { publicKey, privateKey, keys } = setup();
    const items = [item({ gate: "run/approve-merge:1", stepId: "approve-merge" }), item({ gate: "run2/after-stages", runId: "run2", stepId: "approve-merge" })];
    expect(refusal(verifyProof(proofFrom(privateKey, statementFor(publicKey, {}, items)), keys, NOW, AUD))).toBe("malformed");
  });

  it("refuses an item whose run id is not the gate's run", () => {
    const { publicKey, privateKey, keys } = setup();
    const items = [item({ runId: "other" })];
    expect(refusal(verifyProof(proofFrom(privateKey, statementFor(publicKey, {}, items)), keys, NOW, AUD))).toBe("malformed");
  });

  it("refuses an item whose gate id has no run part", () => {
    const { publicKey, privateKey, keys } = setup();
    const items = [item({ gate: "merge", runId: "merge", stepId: "merge" })];
    expect(refusal(verifyProof(proofFrom(privateKey, statementFor(publicKey, {}, items)), keys, NOW, AUD))).toBe("malformed");
  });

  it("refuses the same gate listed twice", () => {
    const { publicKey, privateKey, keys } = setup();
    const items = [item(), item()];
    expect(refusal(verifyProof(proofFrom(privateKey, statementFor(publicKey, {}, items)), keys, NOW, AUD))).toBe("malformed");
  });

  it("classifies a release gate by its gate id when the repeat suffix is present", () => {
    const { publicKey, privateKey, keys } = setup();
    const items = [item(), item({ gate: "run2/after-stages:2", runId: "run2", stepId: "after-stages" })];
    expect(refusal(verifyProof(proofFrom(privateKey, statementFor(publicKey, {}, items)), keys, NOW, AUD))).toBe("mixed-release-batch");
  });

  it.each([NaN, Infinity, -Infinity])("refuses a non-finite clock of %s", (clock) => {
    const { publicKey, privateKey, keys } = setup();
    expect(refusal(verifyProof(proofFrom(privateKey, statementFor(publicKey)), keys, clock, AUD))).toBe("malformed");
  });

  it("refuses non-string input without throwing", () => {
    const { keys } = setup();
    const bad = { statementB64: 5, signatureB64: null } as unknown as Parameters<typeof verifyProof>[0];
    expect(refusal(verifyProof(bad, keys, NOW, AUD))).toBe("malformed");
    expect(refusal(verifyProof(undefined as unknown as Parameters<typeof verifyProof>[0], keys, NOW, AUD))).toBe("malformed");
  });

  it("refuses a deeply nested payload without throwing", () => {
    const { publicKey, privateKey, keys } = setup();
    const deep = JSON.parse(`${'{"a":'.repeat(5000)}1${"}".repeat(5000)}`) as Record<string, unknown>;
    const base = statementFor(publicKey);
    const text = JSON.stringify({ ...base, items: [{ ...item(), payload: deep }] });
    expect(refusal(verifyProof(proofFrom(privateKey, text), keys, NOW, AUD))).toBe("malformed");
  });

  it("verifies the received bytes, not a re-serialization", () => {
    const { publicKey, privateKey, keys } = setup();
    const spaced = JSON.stringify(statementFor(publicKey), null, 2);
    expect(refusal(verifyProof(proofFrom(privateKey, spaced), keys, NOW, AUD))).toBe("accepted");
  });
});

describe("itemsDigest", () => {
  it("is stable across payload key order", () => {
    const a = item({ payload: { decision: "merge", headSha: HEAD } });
    const b = item({ payload: { headSha: HEAD, decision: "merge" } });
    expect(itemsDigest([a])).toBe(itemsDigest([b]));
  });

  it.each([
    ["runId", { runId: "other" }],
    ["stepId", { stepId: "other" }],
    ["payload", { payload: { decision: "abandon" } }],
    ["headSha", { headSha: "c".repeat(40) }],
    ["pr", { pr: 1 }],
  ])("changes when %s changes", (_name, over) => {
    expect(itemsDigest([item(over)])).not.toBe(itemsDigest([item()]));
  });

  it("depends on item order", () => {
    const a = item();
    const b = item({ gate: "run2/merge:1", runId: "run2" });
    expect(itemsDigest([a, b])).not.toBe(itemsDigest([b, a]));
  });
});
