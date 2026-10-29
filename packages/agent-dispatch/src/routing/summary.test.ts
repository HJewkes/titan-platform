import { describe, expect, it } from "vitest";
import { routeMeta, ROUTE_META_KEYS, type RouteDecision } from "./meta.js";
import { summarizeRoutes, type RouteRow } from "./summary.js";

const facts = (present: string[]) => JSON.stringify({ source: "plan-slice", present });

const AGREES: RouteRow = {
  profile: "bd-implementer-lite",
  route_source: "agrees",
  route_wanted: "bd-implementer-lite",
  route_facts: facts(["estimate", "done_when", "owns"]),
};
const SHADOW_LITE: RouteRow = {
  profile: "bd-implementer",
  route_source: "shadow",
  route_wanted: "bd-implementer-lite",
  route_facts: facts(["estimate", "owns", "slice"]),
};
const KEEP_ROLE: RouteRow = { profile: "bd-implementer", route_source: "keep-role", route_facts: facts([]) };
const UNROUTED: RouteRow = { profile: "bd-reviewer" };

describe("summarizeRoutes", () => {
  it("leaves keep-role out of agreement and counts one would-lite", () => {
    const summary = summarizeRoutes([AGREES, SHADOW_LITE, KEEP_ROLE, UNROUTED]);

    expect(summary.decisions).toBe(3);
    expect(summary.agreement).toEqual({ agree: 1, of: 2 });
    expect(summary.wouldLite).toBe(1);
    expect(summary.bySource).toEqual({ agrees: 1, shadow: 1, "keep-role": 1 });
  });

  it("measures fact coverage and lite picks with no owns", () => {
    const noOwns: RouteRow = { ...SHADOW_LITE, route_facts: facts(["estimate"]) };

    const summary = summarizeRoutes([AGREES, noOwns, KEEP_ROLE]);

    expect(summary.factCoverage).toEqual({ covered: 1, of: 3 });
    expect(summary.liteWithoutOwns).toBe(1);
  });

  it("counts a candidate that picks differently from the live table", () => {
    const withCandidate: RouteRow = { ...AGREES, route_candidate_wanted: "bd-implementer" };

    expect(summarizeRoutes([withCandidate, SHADOW_LITE]).candidate).toEqual({ differs: 1, of: 1 });
  });

  it("ignores facts that are not the logged shape", () => {
    const summary = summarizeRoutes([{ ...AGREES, route_facts: "{not json" }]);

    expect(summary.factCoverage).toEqual({ covered: 0, of: 0 });
  });
});

describe("routeMeta", () => {
  it("writes each part under its route_ key and leaves absent parts out", () => {
    const decision: RouteDecision = {
      mode: "shadow",
      source: "shadow",
      profile: "bd-implementer",
      requested: "bd-implementer",
      prior: "standard",
      wanted: "bd-implementer-lite",
      table: "shape-v1@aaaa1111",
      facts: { source: "plan", present: ["estimate", "owns"] },
    };

    expect(routeMeta(decision)).toEqual({
      route_mode: "shadow",
      route_source: "shadow",
      route_prior: "standard",
      route_requested: "bd-implementer",
      route_wanted: "bd-implementer-lite",
      route_table: "shape-v1@aaaa1111",
      route_facts: '{"source":"plan","present":["estimate","owns"]}',
    });
  });

  it("round-trips through summarizeRoutes", () => {
    const meta = routeMeta({ mode: "on", source: "agrees", profile: "x", requested: "x", wanted: "bd-implementer-lite" });

    expect(Object.keys(meta).every((key) => (ROUTE_META_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(summarizeRoutes([meta]).agreement).toEqual({ agree: 1, of: 1 });
  });
});
