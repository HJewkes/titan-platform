import { describe, expect, it } from "vitest";
import { BY_REC_FLOOR, BY_REC_POLICY_SCHEMA, byRecPolicySchema, type OwnerItem } from "@titan-design/owner-queue";
import { byRecCountdown } from "./inbox-by-rec.js";
import { floorClasses } from "./log-floor.js";

const NOW = new Date("2031-03-05T12:00:00.000Z");
const shadow = byRecPolicySchema.parse({ schema: BY_REC_POLICY_SCHEMA });

function deposit(overrides: Partial<OwnerItem> = {}): OwnerItem {
  const item: OwnerItem = {
    id: "dep-1", sources: [{ system: "deposit", ref: "builder/dep-1" }], kind: "decide", door: "two-way", summary: "Keep the ceiling?", context: "The relay retries a failed send.", keys: [], personal: false,
    lens: "blocking-agent", unblocks: [], openedAt: "2031-03-05T02:00:00.000Z", status: "open",
    options: [{ id: "keep", label: "keep" }, { id: "raise", label: "raise" }], recommended: { optionId: "keep", by: "builder" },
  };
  return { ...item, ...overrides };
}

describe("the inbox by-rec countdown", () => {
  it("shows when an eligible open item goes with its recommendation", () => {
    expect(byRecCountdown(deposit(), shadow, NOW)).toEqual({ at: "2031-03-06T02:00:00.000Z", mode: "shadow" });
  });

  it("shows on no item by-rec would leave to the owner", () => {
    expect(byRecCountdown(deposit({ recommended: undefined }), shadow, NOW)).toBeUndefined();
    expect(byRecCountdown(deposit({ door: "one-way" }), shadow, NOW)).toBeUndefined();
    expect(byRecCountdown(deposit({ sources: [{ system: "hitl", ref: "run-1/approve-merge" }] }), shadow, NOW)).toBeUndefined();
    expect(byRecCountdown(deposit(), { ...shadow, mode: "off" }, NOW)).toBeUndefined();
  });

  it("follows the asker's own apply-default wait", () => {
    expect(byRecCountdown(deposit({ default: "keep", onSilence: { action: "apply-default", afterHours: 6 } }), { ...shadow, mode: "live" }, NOW)).toEqual({ at: "2031-03-05T08:00:00.000Z", mode: "live" });
  });
});

describe("the log's floor list", () => {
  it("words every floor class owner-queue holds", () => {
    expect(floorClasses().map((floor) => floor.reason)).toEqual(BY_REC_FLOOR.map(([reason]) => reason));
    expect(floorClasses().filter((floor) => floor.label === floor.reason)).toEqual([]);
  });
});
