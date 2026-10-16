import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReviewGate } from "./gate-review-read.js";
import { buildGateStatement, gateItem, signReason } from "./owner-proof-statement.js";
import { itemsDigest, keyIdOf, keyRing, StatementSchema, verifyProof, type ProofItem } from "./presence-proof.js";

const AUD = "basement";
const IAT = 1_791_500_000;
const NONCE = "0123456789abcdef0123456789abcdef";
const HEAD = "a".repeat(40);

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

const noPrRow = row({ gateId: "run-1/main-red-ack", stepId: "main-red-ack", repo: null, pr: null, headSha: null, rule: null });

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
  const noPr = noPrRow;

  it("throws for a gate with no PR when no ref is given", () => {
    expect(() => gateItem(noPr, { decision: "ack" })).toThrow(/names no PR/);
  });

  it("builds a gate with no PR from the owner's ref", () => {
    const item = gateItem(noPr, { decision: "ack" }, { repo: "HJewkes/titan-platform", pr: 9, headSha: HEAD });

    expect(item).toMatchObject({ gate: "run-1/main-red-ack", runId: "run-1", stepId: "main-red-ack", pr: 9, headSha: HEAD });
  });

  it("keeps the gate id when the ref carries extra keys", () => {
    const ref = { repo: "HJewkes/titan-platform", pr: 9, headSha: HEAD, gate: "run-2/approve-merge" };

    expect(() => gateItem(noPr, { decision: "ack" }, ref)).toThrow(/only repo, pr and headSha/);
  });

  it("throws when a ref disagrees with the gate's own PR", () => {
    expect(() => gateItem(row(), { decision: "merge" }, { repo: "HJewkes/titan-platform", pr: 838, headSha: HEAD })).toThrow(/asks about/);
  });
});

describe("signReason", () => {
  it("names the count, the digest prefix and the PRs", () => {
    const items = [mergeItem(1), mergeItem(2)];
    const reason = signReason(items, itemsDigest(items));

    expect(reason).toBe(`Approve 2 gates, batch ${itemsDigest(items).slice(0, 16)}: HJewkes/titan-platform#1@aaaaaaa HJewkes/titan-platform#2@aaaaaaa`);
  });

  it("stays within 256 characters at 200 items and counts the PRs left out", () => {
    const items = Array.from({ length: 200 }, (_, index) => mergeItem(index + 1));

    const reason = signReason(items, itemsDigest(items));

    expect(reason.length).toBeLessThanOrEqual(256);
    const shown = reason.match(/#\d+@/g)?.length ?? 0;
    expect(reason).toMatch(new RegExp(` \\+${200 - shown} more$`));
    expect(shown).toBeGreaterThan(0);
  });

  it("reads a single non-merge answer as the local resolve dialog does", () => {
    const item = gateItem(row(), { decision: "decline", headSha: HEAD });

    expect(signReason([item], itemsDigest([item]))).toBe(`resolve gate run-1/approve-merge: decline at ${HEAD}`);
  });

  it.each([
    ["a newline in the gate id", { gate: "run-1/approve\nmerge", payload: { decision: "decline" } }],
    ["U+2028 in the decision", { payload: { decision: "decline merge" } }],
  ])("refuses %s in a single item", (_name, over) => {
    const item: ProofItem = { ...mergeItem(1), ...over };

    expect(() => signReason([item], itemsDigest([item]))).toThrow();
  });

  it("refuses a repo name that could hide text in the dialog", () => {
    const items = [{ ...mergeItem(1), repo: "owner/repo\nApprove 1 gate" }, mergeItem(2)];

    expect(() => signReason(items, itemsDigest(items))).toThrow(/cannot be shown safely/);
  });

  it("refuses a digest that is not 64 hex", () => {
    expect(() => signReason([mergeItem(1)], "d".repeat(63))).toThrow(/64 hex/);
  });

  it("refuses a digest over a different set of items than the one shown", () => {
    expect(() => signReason([mergeItem(1)], itemsDigest([mergeItem(2)]))).toThrow(/does not match/);
  });

  it("names the gate for a no-PR gate answered merge, never only the owner's ref", () => {
    const item = gateItem(noPrRow, { decision: "merge" }, { repo: "x/harmless", pr: 1, headSha: HEAD });

    expect(signReason([item], itemsDigest([item]))).toBe("resolve gate run-1/main-red-ack: merge");
  });

  it("names the payload's head when it differs from the item's head", () => {
    const other = "b".repeat(40);
    const item = gateItem(row(), { decision: "merge", headSha: other });

    expect(signReason([item], itemsDigest([item]))).toBe(`resolve gate run-1/approve-merge: merge at ${other}`);
  });

  it("refuses a batch that mixes a decline with a merge", () => {
    const decline = gateItem(row(), { decision: "decline", headSha: HEAD });
    const items = [decline, mergeItem(2)];

    expect(() => signReason(items, itemsDigest(items))).toThrow(/only merges/);
  });

  it("re-checks items it is handed, so a malformed head cannot reach the dialog", () => {
    const bad = `${"a".repeat(39)}\n`;
    const items = [{ ...mergeItem(1), headSha: bad, payload: { decision: "merge", headSha: bad } }, mergeItem(2)];

    expect(() => signReason(items, itemsDigest(items))).toThrow(/valid proof item/);
  });

  it("names the gate for a single no-PR gate answered merge at the ref's head, never only the ref", () => {
    const item = gateItem(noPrRow, { decision: "merge", headSha: HEAD }, { repo: "x/harmless", pr: 1, headSha: HEAD });

    expect(signReason([item], itemsDigest([item]))).toBe(`resolve gate run-1/main-red-ack: merge at ${HEAD}`);
  });

  it("names a PR once, with its count, when two gates ask about it at one head", () => {
    const second = gateItem(row({ gateId: "run-1/approve-merge:2", stepId: "approve-merge:2" }), { decision: "merge", headSha: HEAD });
    const items = [gateItem(row(), { decision: "merge", headSha: HEAD }), second];

    expect(signReason(items, itemsDigest(items))).toMatch(/: HJewkes\/titan-platform#837@aaaaaaa \(2 gates\)$/);
  });

  it.each([["../.."], ["owner/.."], ["../repo"]])("refuses the path-like repo %s in a batch", (repo) => {
    const items = [{ ...mergeItem(1), repo }, mergeItem(2)];

    expect(() => signReason(items, itemsDigest(items))).toThrow(/cannot be shown safely/);
  });
});
