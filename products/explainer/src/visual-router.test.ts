import { describe, expect, it } from "vitest";
import { VisualRouterSchema, findVisualType, loadVisualRouter, renderRoutingTable, visualCard, type VisualRouter } from "./visual-router.js";

const router = loadVisualRouter();
const typeIds = new Set(router.types.map((type) => type.id));
const haveIds = new Set(router.types.filter((type) => type.status === "have").map((type) => type.id));

describe("the pinned visual router", () => {
  it("names a type that exists for every not-this, fallback and pattern target", () => {
    const targets = [
      ...router.types.flatMap((type) => [...type.notThis.map((n) => n.use), ...type.fallback]),
      ...router.patterns.map((pattern) => pattern.nearestType),
    ];

    expect(targets.filter((id) => !typeIds.has(id))).toEqual([]);
  });

  it("routes every type to a built stand-in, and marks a gap exactly when nothing renders it", () => {
    const consistent = ({ id, status, component, route }: VisualRouter["types"][number]): boolean => {
      if (!haveIds.has(route.closest.type)) return false;
      if (status !== "have" || component === null) return route.gap && route.render === null && route.closest.caveat !== null;
      return !route.gap && route.render?.component === component && route.closest.type === id;
    };
    const wrong = router.types.filter((type) => !consistent(type));

    expect(wrong.map((type) => type.id)).toEqual([]);
  });

  it("rejects an upstream field the mirror does not know", () => {
    const [first] = router.types;
    const drifted = { ...router, types: [{ ...first, renamedField: true }] };

    expect(VisualRouterSchema.safeParse(drifted).success).toBe(false);
  });
});

describe("visualCard", () => {
  it("gives a gap type a warning, the closest built type and its not-this list", () => {
    const sankey = findVisualType(router, "sankey");
    if (!sankey) throw new Error("sankey is missing from the pinned router");

    const card = visualCard(sankey);

    expect(card).toMatchObject({ type: "sankey", gap: true, render: null, closest: { type: "dependency-graph", component: "NetworkGraph" } });
    expect(card.warning).toContain("Sankey is not built yet");
    expect(card.not_this.map((n) => n.use)).toEqual(["funnel", "data-flow"]);
  });

  it("gives a built type no warning and its own component", () => {
    const bar = findVisualType(router, "bar");
    if (!bar) throw new Error("bar is missing from the pinned router");

    expect(visualCard(bar)).toMatchObject({ gap: false, warning: null, render: { component: bar.component } });
  });
});

describe("renderRoutingTable", () => {
  it("has one row per type and one card per pattern", () => {
    const table = renderRoutingTable(router);

    expect(router.types.filter((type) => !table.includes(`| \`${type.id}\` | ${type.status} |`))).toEqual([]);
    expect(router.patterns.filter((pattern) => !table.includes(`### ${pattern.name} (\`${pattern.id}\`)`))).toEqual([]);
  });

  it("tells the planner what renders in place of a gap", () => {
    const table = renderRoutingTable(router);

    expect(table).toMatch(/\| `sankey` \| new \| gap: draw `dependency-graph` \(NetworkGraph\) \|/);
  });

  it("escapes a pipe so a cell cannot split its row", () => {
    const [first] = router.types;
    if (!first) throw new Error("pinned router has no types");
    const piped: VisualRouter = { ...router, types: [{ ...first, bestFor: "inputs | outputs" }] };

    expect(renderRoutingTable(piped)).toContain("inputs \\| outputs");
  });
});
