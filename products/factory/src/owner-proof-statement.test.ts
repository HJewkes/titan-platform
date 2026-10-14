import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReviewGate } from "./gate-review-read.js";
import { buildGateStatement, gateItem, signReason } from "./owner-proof-statement.js";
import { itemsDigest, keyIdOf, keyRing, StatementSchema, verifyProof, type ProofItem } from "./presence-proof.js";

const AUD = "basement";
const IAT = 1_791_500_000;
const NONCE = "0123456789abcdef0123456789abcdef";
const HEAD = "a".repeat(40);
const DIGEST = "d".repeat(64);

const row = (over: Partial<ReviewGate> = {}): ReviewGate => ({
  gateId: "run-1/approve-merge",
  runId: "run-1",
  stepId: "approve-merge",
  repo: "HJewkes/titan-platform",
  pr: 837,
  headSha: HEAD,
  rule: "auto-merge",
  batchable: true,
  verdict: null,
  checks: { state: "green", failing: [] },
  createdAt: "2026-10-14T00:00:00.000Z",
  ...over,
});

const mergeItem = (n: number, repo = "HJewkes/titan-platform"): ProofItem =>
  gateItem(row({ gateId: `run-${n}/approve-merge`, runId: `run-${n}`, repo, pr: n }), { decision: "merge", headSha: HEAD });

function signed(items: ProofItem[]) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const built = buildGateStatement({ items, aud: AUD, keyId: keyIdOf(publicKey), iat: IAT, nonce: NONCE });
  const signatureB64 = sign("sha256", built.bytes, { key: privateKey, dsaEncoding: "der" }).toString("base64url");
  return { built, keys: keyRing([publicKey]), proof: { statementB64: built.statementB64, signatureB64 } };
}

describe("buildGateStatement", () => {
  it("builds a statement that verifies under the matching key ring", () => {
    const items = [mergeItem(1), mergeItem(2), mergeItem(3)];
    const { built, keys, proof } = signed(items);

    const result = verifyProof(proof, keys, IAT + 5, AUD);

    expect(result.ok).toBe(true);
    expect(built.digest).toBe(itemsDigest(items));
  });

  it("signs a 240 s window that parses as a v1 statement", () => {
    const { built } = signed([mergeItem(1)]);

    const parsed = StatementSchema.parse(JSON.parse(built.bytes.toString("utf8")));

    expect(parsed.exp - parsed.iat).toBe(240);
    expect(Buffer.from(built.statementB64, "base64url").equals(built.bytes)).toBe(true);
  });

  it("refuses a nonce that is not 32 hex", () => {
    expect(() => buildGateStatement({ items: [mergeItem(1)], aud: AUD, keyId: "0".repeat(16), iat: IAT, nonce: "short" })).toThrow(/invalid/);
  });
});

describe("gateItem", () => {
  const noPr = row({ gateId: "run-1/main-red-ack", stepId: "main-red-ack", repo: null, pr: null, headSha: null, rule: null });

  it("throws for a gate with no PR when no ref is given", () => {
    expect(() => gateItem(noPr, { decision: "ack" })).toThrow(/names no PR/);
  });

  it("builds a gate with no PR from the owner's ref", () => {
    const item = gateItem(noPr, { decision: "ack" }, { repo: "HJewkes/titan-platform", pr: 9, headSha: HEAD });

    expect(item).toMatchObject({ gate: "run-1/main-red-ack", runId: "run-1", stepId: "main-red-ack", pr: 9, headSha: HEAD });
  });

  it("throws when a ref disagrees with the gate's own PR", () => {
    expect(() => gateItem(row(), { decision: "merge" }, { repo: "HJewkes/titan-platform", pr: 838, headSha: HEAD })).toThrow(/asks about/);
  });
});

describe("signReason", () => {
  it("names the count, the digest prefix and the PRs", () => {
    const reason = signReason([mergeItem(1), mergeItem(2)], DIGEST);

    expect(reason).toBe(`Approve 2 gates, batch ${"d".repeat(16)}: titan-platform#1@aaaaaaa titan-platform#2@aaaaaaa`);
  });

  it("stays within 256 characters at 200 items and counts the PRs left out", () => {
    const items = Array.from({ length: 200 }, (_, index) => mergeItem(index + 1));

    const reason = signReason(items, DIGEST);

    expect(reason.length).toBeLessThanOrEqual(256);
    const shown = reason.match(/#\d+@/g)?.length ?? 0;
    expect(reason).toMatch(new RegExp(` \\+${200 - shown} more$`));
    expect(shown).toBeGreaterThan(0);
  });

  it("reads a single non-merge answer as the local resolve dialog does", () => {
    const item = gateItem(row(), { decision: "decline", headSha: HEAD });

    expect(signReason([item], DIGEST)).toBe(`resolve gate run-1/approve-merge: decline at ${HEAD}`);
  });

  it.each([
    ["a newline in the gate id", { gate: "run-1/approve\nmerge", payload: { decision: "decline" } }],
    ["U+2028 in the decision", { payload: { decision: "decline merge" } }],
  ])("refuses %s in a single item", (_name, over) => {
    const item = { ...mergeItem(1), ...over } as ProofItem;

    expect(() => signReason([item], DIGEST)).toThrow();
  });

  it("refuses a repo name that could hide text in the dialog", () => {
    const item = { ...mergeItem(1), repo: "owner/repo\nApprove 1 gate" };

    expect(() => signReason([item, mergeItem(2)], DIGEST)).toThrow(/cannot be shown safely/);
  });

  it("refuses a digest that is not 64 hex", () => {
    expect(() => signReason([mergeItem(1)], "d".repeat(63))).toThrow(/64 hex/);
  });
});
