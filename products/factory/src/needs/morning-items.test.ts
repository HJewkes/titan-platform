import { ownerItemSchema } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { morningIds, morningOwnerItem, numberedMorningItems } from "./morning-items.js";

const SHA = "ab".repeat(20);
const OPENED = "2026-10-05T08:00:00.000Z";

const itemOf = (text: string) => morningOwnerItem("seat-a", { number: "4", text }, "morning:seat-a:4", OPENED);

describe("morningOwnerItem", () => {
  it("keys a merge command by its exact PR head and its first task id only", () => {
    const item = itemOf(`**widgets#11:** T-9 after T-3: \`acme/Widgets 11 ${SHA} ~/src/widgets\` (two-way). Rec: merge.`);

    expect(item.keys).toEqual(["pr:widgets#11", "task:T-9", `pr:acme/widgets#11@${SHA}`]);
    expect(item).toMatchObject({ kind: "do", door: "two-way", lens: "blocking-merge", command: `acme/Widgets 11 ${SHA} ~/src/widgets` });
    expect(item.sources).toEqual([{ system: "morning", ref: "seat-a:4" }]);
  });

  it("treats any one-way mention, and a missing door, as one-way", () => {
    expect(itemOf("Q1 (one-way: rows are permanent), Q2 two-way. Rec: defaults.").door).toBe("one-way");
    expect(itemOf("Pick a colour for the badge.").door).toBe("one-way");
  });

  it("clips a long ask to a schema-valid summary and keeps the full text as context", () => {
    const text = `Decide ${"x".repeat(400)}`;

    const item = itemOf(text);

    expect(ownerItemSchema.safeParse(item).success).toBe(true);
    expect(item.summary).toHaveLength(280);
    expect(item.context).toBe(text);
  });

  it("gives an empty item a placeholder summary rather than an invalid one", () => {
    expect(ownerItemSchema.safeParse(itemOf("**")).success).toBe(true);
  });
});

describe("morningIds", () => {
  it("suffixes a number the seat wrote twice", () => {
    const entries = numberedMorningItems("## Morning queue (owner only)\n3. a\n4. b\n3. c\n");

    expect(morningIds("seat-a", entries)).toEqual(["morning:seat-a:3", "morning:seat-a:4", "morning:seat-a:3.2"]);
  });
});
