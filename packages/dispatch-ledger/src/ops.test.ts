import { describe, expect, it } from "vitest";
import {
  addClaim,
  claimKey,
  heldClaims,
  isStalled,
  laneClaims,
  ledgerImplementers,
  readySlices,
  slotMismatch,
  type StackPredicate,
} from "./ops.js";
import { EMPTY_LEDGER, type Claim, type Ledger, type StackedOn } from "./schema.js";

const AT = "2026-01-05T08:00:00.000Z";

const claim = (over: Partial<Claim> = {}): Claim => ({
  taskId: "TX-1",
  initiative: "demo",
  agentId: "a1",
  spawnedAt: AT,
  phase: "implementing",
  phaseAt: AT,
  ...over,
});

const slice = (name: string, over: Partial<Claim> = {}): Claim => ({
  taskId: "TX-1",
  initiative: "demo",
  spawnedAt: AT,
  phase: "queued",
  phaseAt: AT,
  slice: name,
  ...over,
});

const ledgerOf = (...claims: Claim[]): Ledger => ({ version: 1, claims });

describe("addClaim", () => {
  it("refuses a second claim on a held task", () => {
    const ledger = addClaim(EMPTY_LEDGER, claim());

    expect(ledger.claims).toEqual([claim()]);
    expect(() => addClaim(ledger, claim())).toThrow("task TX-1 is already claimed");
  });

  it("holds one claim per slice of a task and refuses the same slice twice", () => {
    const a = claim({ slice: "a" });
    const ledger = addClaim(addClaim(EMPTY_LEDGER, a), claim({ slice: "b" }));

    expect(ledger.claims.map((c) => c.slice)).toEqual(["a", "b"]);
    expect(() => addClaim(ledger, a)).toThrow("slice a is already claimed");
  });

  it("claims a task again once its earlier claim is done", () => {
    const ledger = ledgerOf(claim({ phase: "done" }));

    expect(addClaim(ledger, claim()).claims).toHaveLength(2);
  });
});

describe("isStalled", () => {
  it("marks an implementing claim stalled after four hours", () => {
    expect(isStalled(claim(), new Date("2026-01-05T11:59:00.000Z"))).toBe(false);
    expect(isStalled(claim(), new Date("2026-01-05T12:01:00.000Z"))).toBe(true);
  });

  it("marks a claim with a stall reason stalled at once, and never times out a phase without a timeout", () => {
    const later = new Date("2026-02-01T00:00:00.000Z");

    expect(isStalled(claim({ stalledReason: "x" }), new Date(AT))).toBe(true);
    expect(isStalled(claim({ phase: "shepherding" }), later)).toBe(false);
  });
});

describe("held and lane claims", () => {
  it("holds every claim short of done, and a lane only while an agent works", () => {
    const ledger = ledgerOf(
      claim({ slice: "a", phase: "queued" }),
      claim({ slice: "b", phase: "spawning" }),
      claim({ slice: "c", phase: "shepherding" }),
      claim({ slice: "d", phase: "done" }),
    );

    expect(heldClaims(ledger).map((c) => c.slice)).toEqual(["a", "b", "c"]);
    expect(laneClaims(ledger).map((c) => c.slice)).toEqual(["b"]);
  });

  it("keys a claim by task and slice", () => {
    expect(claimKey({ taskId: "TX-1", slice: "a" })).toBe("TX-1#a");
    expect(claimKey({ taskId: "TX-1" })).toBe("TX-1#");
  });
});

describe("ledgerImplementers", () => {
  it("counts the seat's implementing claims and spawns headed for implementing", () => {
    const ledger = ledgerOf(
      claim({ slice: "a", seat: "seat-a" }),
      claim({ slice: "b", seat: "seat-a", phase: "spawning", nextPhase: "implementing" }),
      claim({ slice: "c", seat: "seat-a", phase: "spawning", nextPhase: "reviewing" }),
      claim({ slice: "d", seat: "seat-a", phase: "reviewing" }),
      claim({ slice: "e", seat: "seat-b" }),
    );

    expect(ledgerImplementers(ledger, "seat-a")).toBe(2);
  });
});

describe("slotMismatch", () => {
  it("flags a ledger more than 3 claims ahead of the live agents", () => {
    expect(slotMismatch(5, 1)).toBe("MISMATCH ledger 5 vs 1 live");
  });

  it("stays quiet at exactly 3 ahead", () => {
    expect(slotMismatch(4, 1)).toBeUndefined();
  });
});

describe("readySlices", () => {
  const PARENT_PR = "https://github.com/example-org/example-repo/pull/10";
  const ON: StackedOn = { taskId: "TX-1", slice: "a", pr: PARENT_PR, branch: "agent-chat/bd-tx-1-a" };
  const stackA: StackPredicate = (_c, dep) => (dep === "a" ? ON : undefined);

  it("readies a slice whose dependency is done, leaving one still waiting", () => {
    const ledger = ledgerOf(slice("a", { phase: "done" }), slice("b", { dependsOn: ["a"] }), slice("c", { dependsOn: ["x"] }));

    expect(readySlices(ledger).map((c) => c.slice)).toEqual(["b"]);
  });

  it("readies a slice whose dependency was released", () => {
    const ledger: Ledger = { ...ledgerOf(slice("b", { dependsOn: ["a"] })), slicesReleased: { "TX-1": ["a"] } };

    expect(readySlices(ledger).map((c) => c.slice)).toEqual(["b"]);
  });

  it("keeps a queued slice out while its task is held", () => {
    const ledger = ledgerOf(slice("s2"));

    expect(readySlices(ledger, new Map([["TX-1", "backoff"]]))).toEqual([]);
    expect(readySlices(ledger, new Map())).toEqual([slice("s2")]);
  });

  it("never readies a queued slice linked to a hand-dispatched PR", () => {
    const ledger = ledgerOf(slice("a", { phase: "done" }), slice("b", { pr: "o/r#41" }));

    expect(readySlices(ledger)).toEqual([]);
  });

  it("admits a slice with one unmet dependency through stack, carrying stackedOn", () => {
    const ledger = ledgerOf(slice("a", { phase: "shepherding" }), slice("b", { dependsOn: ["a"] }));

    expect(readySlices(ledger)).toEqual([]);
    expect(readySlices(ledger, new Map(), stackA)).toEqual([slice("b", { dependsOn: ["a"], stackedOn: ON })]);
  });

  it("never stacks a slice with two unmet dependencies", () => {
    const ledger = ledgerOf(slice("a", { phase: "shepherding" }), slice("d", { dependsOn: ["a", "c"] }));

    expect(readySlices(ledger, new Map(), () => ON)).toEqual([]);
  });
});
