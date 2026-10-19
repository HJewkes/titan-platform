import { describe, expect, it } from "vitest";
import { fetchPublished, planPublish, renderPlan } from "./release-stranded.mjs";

const pkg = (name, version, fields = {}) => ({ name: `@example/${name}`, version, ...fields });
const npm = (entries) => new Map(Object.entries(entries).map(([name, versions]) => [`@example/${name}`, versions]));
const names = (list) => list.map((entry) => entry.name);

describe("planPublish", () => {
  it("publishes a version npm lacks and leaves a published one alone", () => {
    const plan = planPublish([pkg("graph", "0.18.0"), pkg("store", "1.0.0")], npm({ graph: ["0.17.1"], store: ["1.0.0"] }));

    expect(names(plan.publish)).toEqual(["@example/graph"]);
    expect(names(plan.current)).toEqual(["@example/store"]);
  });

  it("skips a package npm has never seen instead of failing the plan", () => {
    const plan = planPublish([pkg("fresh", "0.1.0"), pkg("graph", "0.18.0")], npm({ fresh: null, graph: ["0.17.1"] }));

    expect(names(plan.neverPublished)).toEqual(["@example/fresh"]);
    expect(names(plan.publish)).toEqual(["@example/graph"]);
  });

  it("holds back a stranded package whose runtime dependency chain reaches a never-published one", () => {
    const packages = [
      pkg("fresh", "0.1.0"),
      pkg("mid", "0.2.0", { peerDependencies: { "@example/fresh": "workspace:^" } }),
      pkg("top", "0.3.0", { dependencies: { "@example/mid": "workspace:^" } }),
    ];

    const plan = planPublish(packages, npm({ fresh: null, mid: ["0.1.0"], top: ["0.2.0"] }));

    expect(plan.heldBack).toEqual([
      { name: "@example/mid", version: "0.2.0", blockedBy: ["@example/fresh"] },
      { name: "@example/top", version: "0.3.0", blockedBy: ["@example/mid"] },
    ]);
    expect(plan.publish).toEqual([]);
  });

  it("never holds back for a dev dependency, a registry dependency, or a dependency already on npm", () => {
    const packages = [
      pkg("fresh", "0.1.0"),
      pkg("store", "1.0.0"),
      pkg("graph", "0.18.0", { devDependencies: { "@example/fresh": "workspace:^" }, dependencies: { "@example/store": "workspace:^", zod: "^3" } }),
    ];

    const plan = planPublish(packages, npm({ fresh: null, store: ["1.0.0"], graph: ["0.17.1"] }));

    expect(names(plan.publish)).toEqual(["@example/graph"]);
    expect(plan.heldBack).toEqual([]);
  });

  it("ignores private packages entirely", () => {
    const plan = planPublish([pkg("product", "2.0.0", { private: true })], npm({ product: null }));

    expect(plan).toEqual({ publish: [], neverPublished: [], heldBack: [], current: [] });
  });
});

describe("fetchPublished", () => {
  const respond = (status, body) => async () => ({ status, ok: status < 300, json: async () => body });

  it("reads the versions npm has", async () => {
    expect(await fetchPublished("@example/graph", respond(200, { versions: { "0.17.0": {}, "0.17.1": {} } }))).toEqual(["0.17.0", "0.17.1"]);
  });

  it("reads a 404 as never published", async () => {
    expect(await fetchPublished("@example/fresh", respond(404, {}))).toBeNull();
  });

  it("throws on any other registry answer rather than guess", async () => {
    await expect(fetchPublished("@example/graph", respond(503, {}))).rejects.toThrow("503");
  });

  it("asks for the scoped name with its slash encoded", async () => {
    const urls = [];
    await fetchPublished("@example/graph", async (url) => (urls.push(url), { status: 404 }));

    expect(urls).toEqual(["https://registry.npmjs.org/@example%2fgraph"]);
  });
});

describe("renderPlan", () => {
  it("names every publish, skip and hold, and marks a dry run", () => {
    const plan = {
      publish: [pkg("graph", "0.18.0")],
      neverPublished: [pkg("fresh", "0.1.0")],
      heldBack: [{ ...pkg("mid", "0.2.0"), blockedBy: ["@example/fresh"] }],
      current: [pkg("store", "1.0.0")],
    };

    const text = renderPlan(plan, true);

    expect(text).toContain("Dry run: would publish 1 stranded version(s)");
    expect(text).toContain("- @example/graph@0.18.0");
    expect(text).toContain("- @example/fresh@0.1.0");
    expect(text).toContain("- @example/mid@0.2.0 (needs @example/fresh)");
    expect(text).toContain("Already on npm: 1 package(s).");
  });
});
