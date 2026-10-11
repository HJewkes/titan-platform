import { describe, expect, it } from "vitest";
import { fromDeposit, ownerItemDepositSchema, type OwnerItemDeposit } from "./deposit.js";
import { ownerItemSchema } from "./schema.js";

const NOW = new Date("2026-01-01T00:00:00Z");

function deposit(overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit {
  return {
    depositId: "d-1",
    asker: "agent-a",
    kind: "decide",
    door: "two-way",
    summary: "Pick a cache layout",
    context: "Two layouts fit the read path.",
    options: [
      { id: "flat", label: "Flat" },
      { id: "nested", label: "Nested" },
    ],
    recommended: { optionId: "flat", by: "agent-a", confidence: 0.7 },
    ...overrides,
  };
}

describe("ownerItemDepositSchema", () => {
  it("accepts a deposit carrying only agent-settable fields", () => {
    expect(ownerItemDepositSchema.safeParse(deposit()).success).toBe(true);
  });

  it.each([
    ["an id", { id: "chat:m-1" }],
    ["a status", { status: "answered" }],
    ["an answer", { answer: { optionId: "flat", by: { class: "owner", id: "o", channel: "web" }, at: NOW.toISOString() } }],
    ["a route", { route: { target: "owner-now", reason: "urgent", shadow: false } }],
    ["an authority", { authority: { table: "t", ruleId: "r", resolvers: ["owner"] } }],
    ["a lint list", { lint: [] }],
  ])("refuses a deposit carrying %s", (_label, extra) => {
    expect(ownerItemDepositSchema.safeParse({ ...deposit(), ...extra }).success).toBe(false);
  });

  it("refuses a hidden recommendation", () => {
    const hidden = { ...deposit(), recommended: { optionId: "flat", by: "agent-a", hidden: true } };
    expect(ownerItemDepositSchema.safeParse(hidden).success).toBe(false);
  });

  it.each([["asker"], ["depositId"]] as const)("refuses a deposit with no %s", (field) => {
    expect(ownerItemDepositSchema.safeParse({ ...deposit(), [field]: undefined }).success).toBe(false);
  });
});

describe("fromDeposit", () => {
  it("files an open item from the deposit source that passes ownerItemSchema", () => {
    const filed = fromDeposit(deposit(), NOW);

    expect(ownerItemSchema.parse(filed)).toEqual(filed);
    expect(filed).toMatchObject({
      sources: [{ system: "deposit", ref: "agent-a/d-1" }],
      status: "open",
      lens: "blocking-agent",
      openedAt: "2026-01-01T00:00:00.000Z",
      keys: [],
      unblocks: [],
      personal: false,
    });
  });

  it("derives the lens from the kind", () => {
    expect(fromDeposit(deposit({ kind: "know", options: undefined, recommended: undefined }), NOW).lens).toBe("fyi");
  });

  it("maps a repeated depositId to the same item id", () => {
    const first = fromDeposit(deposit(), NOW);
    const again = fromDeposit(deposit({ summary: "Pick a cache layout, revised" }), new Date("2026-01-02T00:00:00Z"));

    expect(again.id).toBe(first.id);
    expect(first.id).toMatch(/^deposit:[0-9a-f]{32}$/);
  });

  it("gives two askers with one depositId different ids, even when a slash could join them", () => {
    const ids = [
      fromDeposit(deposit({ asker: "agent-a" }), NOW).id,
      fromDeposit(deposit({ asker: "agent-b" }), NOW).id,
      fromDeposit(deposit({ asker: "a/b", depositId: "c" }), NOW).id,
      fromDeposit(deposit({ asker: "a", depositId: "b/c" }), NOW).id,
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("throws on a deposit that sets a system field", () => {
    expect(() => fromDeposit({ ...deposit(), status: "answered" } as OwnerItemDeposit, NOW)).toThrow();
  });
});
