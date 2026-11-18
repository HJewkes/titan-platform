import { describe, expect, it } from "vitest";
import { fakeSha } from "@titan-design/github";
import { LIVE_FIELDS } from "../config-ref.js";
import { partialFake } from "@titan-design/test-kit";
import type { MergeFacts } from "@titan-design/authority";
import { ownerTierStamp } from "./owner-tier.js";
import { ownerTierRows } from "./risk-tier.js";

const HEAD = fakeSha("owner-tier-wiring-head");
const HOLD_COMMAND = "products/factory/src/shepherd/release.ts";

/** Just what the stamp reads: a head and its changed paths. */
const evidenceAt = (paths: string[]) => ({ head: HEAD, merge: partialFake<MergeFacts>({ head: HEAD, changedPaths: paths }) });

describe("the owner-tier gate guards its own code", () => {
  it.each(["products/factory/src/shepherd/owner-tier.ts", "products/factory/src/shepherd/merge-facts.ts"])("a change to %s is a merge-policy row", (path) => {
    expect(ownerTierRows({ paths: [path], ciBudget: false })).toEqual([`merge-policy ${path}`]);
  });
});

describe("the owner-tier mode's wiring", () => {
  it("an absent config key reads as shadow at the config reader", () => {
    expect(LIVE_FIELDS["shepherd.gateReset.ownerTier"]({})).toBe("shadow");
    expect(LIVE_FIELDS["shepherd.gateReset.ownerTier"]({ gateReset: { ownerTier: "on" } })).toBe("on");
  });

  it("a route that lost its wiring passes no mode, which fails closed as on", () => {
    const stamp = ownerTierStamp(undefined, evidenceAt([HOLD_COMMAND]));

    expect(stamp.ownerTier).toEqual({ mode: "on", rows: [`hold-command ${HOLD_COMMAND}`] });
  });
});
