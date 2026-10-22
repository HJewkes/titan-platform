import { describe, expect, it } from "vitest";
import { fromDeposit, type OwnerItemDeposit } from "./deposit.js";
import { mergeByKeys } from "./merge.js";
import { opKeys, ownerOpSchema, type OwnerOp } from "./op.js";
import { ownerItemSchema, type OwnerItem } from "./schema.js";

const NOW = new Date("2026-01-01T00:00:00Z");
const HEAD = "a".repeat(40);

const OPS: OwnerOp[] = [
  { kind: "resolve-gate", gateId: "g-1", headSha: HEAD, decision: "merge" },
  { kind: "release-hold", repo: "acme/widgets", pr: 7, headSha: HEAD, holdClass: "g10" },
  { kind: "merge-at-head", repo: "acme/widgets", pr: 7, headSha: HEAD },
  { kind: "close-pr", repo: "acme/widgets", pr: 7, headSha: HEAD },
  { kind: "factory-config-set", path: "shepherd.gateReset.heldRepair", value: "on", expectFrom: "off" },
  { kind: "deploy-pause-clear", pausedAt: "2026-01-01T00:00:00Z", target: "abc1234" },
  { kind: "retire-agent", name: "worker-a", agentId: "agent-1", force: true },
];

function deposit(op: unknown, overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit {
  return { depositId: "d-1", asker: "agent-a", kind: "do", door: "two-way", summary: "Merge acme/widgets#7", context: "CI is green.", op, ...overrides } as OwnerItemDeposit;
}

function hitlItem(keys: string[]): OwnerItem {
  return ownerItemSchema.parse({
    id: "gate:g-1", sources: [{ system: "hitl", ref: "g-1" }], kind: "approve", door: "one-way", summary: "Approve merge",
    context: "", keys, personal: false, lens: "blocking-merge", unblocks: [], openedAt: NOW.toISOString(), status: "open",
  });
}

describe("ownerOpSchema", () => {
  it.each(OPS.map((op) => [op.kind, op] as const))("accepts a %s op", (_kind, op) => {
    expect(ownerOpSchema.parse(op)).toEqual(op);
  });

  it.each(OPS.map((op) => [op.kind, op] as const))("refuses a %s op carrying an extra key", (_kind, op) => {
    expect(ownerOpSchema.safeParse({ ...op, command: "gh pr merge 7" }).success).toBe(false);
  });

  it("refuses an unknown op kind", () => {
    expect(ownerOpSchema.safeParse({ kind: "run-shell", command: "true" }).success).toBe(false);
  });

  it("refuses a config path that is not a dotted key", () => {
    expect(ownerOpSchema.safeParse({ kind: "factory-config-set", path: "../config.json", value: 1 }).success).toBe(false);
  });
});

describe("a deposit carrying an op", () => {
  it("refuses a merge-at-head with a 39-char head sha", () => {
    const short = { kind: "merge-at-head", repo: "acme/widgets", pr: 7, headSha: "a".repeat(39) };

    expect(() => fromDeposit(deposit(short), NOW)).toThrow();
  });

  it("refuses an op with an extra key", () => {
    const extra = { kind: "close-pr", repo: "acme/widgets", pr: 7, headSha: HEAD, admin: true };

    expect(() => fromDeposit(deposit(extra), NOW)).toThrow();
  });

  it("files the op on the item and keys it to the PR at its head", () => {
    const filed = fromDeposit(deposit(OPS[2]), NOW);

    expect(ownerItemSchema.parse(filed).op).toEqual(OPS[2]);
    expect(filed.keys).toEqual([`pr:acme/widgets#7@${HEAD}`]);
  });

  it("merges with the hitl item for the same PR at the same head", () => {
    const filed = fromDeposit(deposit({ kind: "merge-at-head", repo: "Acme/Widgets", pr: 7, headSha: HEAD }), NOW);

    const merged = mergeByKeys([hitlItem([`pr:acme/widgets#7@${HEAD}`]), filed]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.sources.map((source) => source.system)).toEqual(["hitl", "deposit"]);
  });

  it("stays apart from the hitl item for the same PR at another head", () => {
    const filed = fromDeposit(deposit(OPS[2]), NOW);

    expect(mergeByKeys([hitlItem([`pr:acme/widgets#7@${"b".repeat(40)}`]), filed])).toHaveLength(2);
  });

  it("does not repeat a PR key the deposit already carries", () => {
    const filed = fromDeposit(deposit(OPS[3], { keys: [`pr:acme/widgets#7@${HEAD}`, "task:PRJ-1"] }), NOW);

    expect(filed.keys).toEqual([`pr:acme/widgets#7@${HEAD}`, "task:PRJ-1"]);
  });

  it.each(OPS.map((op) => [op.kind, op] as const))("never derives a gate key from a %s op", (_kind, op) => {
    expect(fromDeposit(deposit(op), NOW).keys.some((key) => key.startsWith("gate:"))).toBe(false);
  });

  it("files a deposit with no op as an item with no op and no derived key", () => {
    const { op: _none, ...plain } = deposit(OPS[2]);

    const filed = fromDeposit(plain, NOW);

    expect(filed).not.toHaveProperty("op");
    expect(filed.keys).toEqual([]);
  });
});

describe("opKeys", () => {
  it("gives a gate op no key", () => {
    expect(opKeys(OPS[0]!)).toEqual([]);
  });
});
