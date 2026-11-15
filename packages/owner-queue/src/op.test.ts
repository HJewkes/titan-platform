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
  { kind: "merge-at-head", repo: "acme/widgets", pr: 7, headSha: HEAD, waitFor: "adversary-loop" },
  { kind: "close-pr", repo: "acme/widgets", pr: 7, headSha: HEAD },
  { kind: "factory-config-set", path: "shepherd.gateReset.heldRepair", value: "on", expectFrom: "off" },
  { kind: "deploy-pause-clear", pausedAt: "2026-01-01T00:00:00Z", target: "abc1234" },
  { kind: "retire-agent", name: "worker-a", agentId: "agent-1", force: true },
];

function deposit(op: OwnerOp | undefined, overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit {
  return { depositId: "d-1", asker: "agent-a", kind: "do", door: "two-way", summary: "Merge acme/widgets#7", context: "CI is green.", ...(op === undefined ? {} : { op }), ...overrides };
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
    const short: OwnerOp = { kind: "merge-at-head", repo: "acme/widgets", pr: 7, headSha: "a".repeat(39) };

    expect(() => fromDeposit(deposit(short), NOW)).toThrow();
  });

  it("refuses an op with an extra key", () => {
    const extra = { kind: "close-pr" as const, repo: "acme/widgets", pr: 7, headSha: HEAD, admin: true };

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
    const filed = fromDeposit(deposit(undefined), NOW);

    expect(filed).not.toHaveProperty("op");
    expect(filed.keys).toEqual([]);
  });
});

const START_SESSION = {
  kind: "start-session",
  name: "research-lead",
  profile: "researcher",
  host: "build-box",
  account: "least-used",
  cwd: "~/projects/example",
  surface: "tmux",
  remoteControl: true,
  briefPath: "/srv/briefs/research.md",
} as const;

describe("a start-session op", () => {
  it("parses with the least-used account", () => {
    expect(ownerOpSchema.parse(START_SESSION)).toEqual(START_SESSION);
  });

  it("parses with a named account and the brief's sha256", () => {
    const pinned = { ...START_SESSION, account: "work-2", cwd: "/srv/work/example", briefSha256: "c".repeat(64) };

    expect(ownerOpSchema.parse(pinned)).toEqual(pinned);
  });

  it("refuses an extra key", () => {
    expect(ownerOpSchema.safeParse({ ...START_SESSION, command: "claude --dangerously-skip-permissions" }).success).toBe(false);
  });

  it("refuses a relative cwd", () => {
    expect(ownerOpSchema.safeParse({ ...START_SESSION, cwd: "projects/example" }).success).toBe(false);
  });

  it("refuses a cwd that climbs with ..", () => {
    expect(ownerOpSchema.safeParse({ ...START_SESSION, cwd: "/srv/work/../../etc" }).success).toBe(false);
  });

  it("refuses a brief path carrying a control character", () => {
    expect(ownerOpSchema.safeParse({ ...START_SESSION, briefPath: "/srv/briefs/research.md\nrm -rf ~" }).success).toBe(false);
  });

  it("refuses a 63-hex brief sha256", () => {
    expect(ownerOpSchema.safeParse({ ...START_SESSION, briefSha256: "c".repeat(63) }).success).toBe(false);
  });
});

describe("opKeys", () => {
  it("gives a gate op no key", () => {
    expect(opKeys(OPS[0]!)).toEqual([]);
  });

  it("keys a start-session op to the session it names", () => {
    expect(opKeys(START_SESSION)).toEqual(["session:research-lead"]);
  });
});
