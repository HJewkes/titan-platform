import { describe, expect, it } from "vitest";
import { HARD_STOP_CLASSES, charterPolicySchema } from "./charter-policy.js";
import { resolveSeatPolicy } from "./resolve-policy.js";
import { seatConfigSchema } from "./seat-config.js";
import charterFixture from "./fixtures/charter.json" with { type: "json" };
import seatFixture from "./fixtures/seat-f.json" with { type: "json" };

const charter = charterPolicySchema.parse(charterFixture);
const seatWith = (extra: Record<string, unknown>) => seatConfigSchema.parse({ ...seatFixture, ...extra });

describe("resolveSeatPolicy: defaults", () => {
  it("returns the charter defaults for a seat that overrides nothing", () => {
    expect(resolveSeatPolicy(charter, seatWith({})).defaults).toEqual(charter.defaults);
  });

  it("lets a seat override retire_k and stale_pr_days", () => {
    const retireK = { implementer: 50, reviewer: 60, planner: 70 };

    const { defaults } = resolveSeatPolicy(charter, seatWith({ defaults: { retire_k: retireK, stale_pr_days: 3 } }));

    expect(defaults.retire_k).toEqual(retireK);
    expect(defaults.stale_pr_days).toBe(3);
    expect(defaults.teleport_k).toBe(charter.defaults.teleport_k);
  });

  it("merges kind_weights and share_caps key by key, as the burndown scorer does", () => {
    const seat = seatWith({ kind_weights: { nit: 0.9, discovery: 1 }, share_caps: { nit: 0.5 } });

    const { defaults } = resolveSeatPolicy(charter, seat);

    expect(defaults.kind_weights).toEqual({ ...charter.defaults.kind_weights, nit: 0.9, discovery: 1 });
    expect(defaults.share_caps).toEqual({ ...charter.defaults.share_caps, nit: 0.5 });
  });

  it("lets a top-level kind weight beat the same key under the seat's defaults", () => {
    const seat = seatWith({ kind_weights: { nit: 0.9 }, defaults: { kind_weights: { nit: 0.1, docs: 0.2 } } });

    const { kind_weights } = resolveSeatPolicy(charter, seat).defaults;

    expect(kind_weights.nit).toBe(0.9);
    expect(kind_weights.docs).toBe(0.2);
  });

  it("leaves the charter and seat it was given unchanged", () => {
    const seat = seatWith({ kind_weights: { nit: 0.9 } });
    const before = structuredClone({ charter, seat });

    resolveSeatPolicy(charter, seat);

    expect({ charter, seat }).toEqual(before);
  });
});

describe("resolveSeatPolicy: the stricter rule wins", () => {
  it("keeps a global hard stop the seat does not list", () => {
    const { hard_stops } = resolveSeatPolicy(charter, seatWith({ extra_hard_stops: ["seat-stop"] }));

    expect(hard_stops).toEqual([...HARD_STOP_CLASSES, "seat-stop"]);
  });

  it("adds a seat's extra hard stop the charter does not list", () => {
    const narrow = { ...charter, hard_stops: ["deploy" as const] };

    const { hard_stops } = resolveSeatPolicy(narrow, seatWith({ extra_hard_stops: ["force-push", "deploy"] }));

    expect(hard_stops).toEqual(["deploy", "force-push"]);
  });

  it.each([
    ["an empty hard_stops list", { hard_stops: [] }],
    ["hard_stops under defaults", { defaults: { hard_stops: [] } }],
    ["an empty extra_hard_stops", { extra_hard_stops: [] }],
  ])("never removes a global hard stop for a seat with %s", (_scenario, extra) => {
    expect(resolveSeatPolicy(charter, seatWith(extra)).hard_stops).toEqual([...HARD_STOP_CLASSES]);
  });

  it("takes a seat's lower stop_short_factor", () => {
    const seat = seatWith({ defaults: { stop_short_factor: 0.5 } });

    expect(resolveSeatPolicy(charter, seat).defaults.stop_short_factor).toBe(0.5);
  });

  it("keeps the charter's stop_short_factor over a seat's higher one", () => {
    const seat = seatWith({ defaults: { stop_short_factor: 1 } });

    expect(resolveSeatPolicy(charter, seat).defaults.stop_short_factor).toBe(charter.defaults.stop_short_factor);
  });
});
