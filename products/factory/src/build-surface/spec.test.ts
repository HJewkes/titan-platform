import { describe, expect, it } from "vitest";
import { demoSpec, fakeBuild } from "../test-support/build-surface.js";
import { BUILD_SURFACE_STEPS, DISPATCH_STEPS } from "./manifest.js";
import { buildSurfaceRoutes } from "./routes.js";
import { agentNameOf, evidenceDirOf, parseBuildSpec, readySlices } from "./spec.js";

describe("the build spec", () => {
  it("reads the front matter and fills in the defaults the workflow relies on", () => {
    const spec = parseBuildSpec(demoSpec());

    expect(spec).toMatchObject({ base: "main", maxFixRounds: 12, noImprovementRounds: 3, concurrency: 3, implementer: { profile: "bd-implementer" } });
    expect(agentNameOf(spec, spec.slices[0]!)).toBe("bs-demo-repo-shell");
    expect(evidenceDirOf(spec, "shell", "abc")).toBe("/work/demo-repo/evidence/shell/abc");
  });

  it.each([
    ["a cycle", [{ id: "a", title: "A", brief: "b", dependsOn: ["b"] }, { id: "b", title: "B", brief: "b", dependsOn: ["a"] }], /slice "a" is on a dependency cycle/],
    ["an unknown dependency", [{ id: "a", title: "A", brief: "b", dependsOn: ["zz"] }], /depends on unknown slice "zz"/],
    ["a duplicate id", [{ id: "a", title: "A", brief: "b" }, { id: "a", title: "A2", brief: "b" }], /slice "a" is declared twice/],
    ["an id that is no agent name", [{ id: "Bad_Id", title: "A", brief: "b" }], /a lowercase letter, then/],
  ])("refuses %s, which no wave could build", (_name, slices, error) => {
    expect(() => parseBuildSpec(demoSpec({ slices }))).toThrow(error);
  });

  it("refuses a relative clone, since serve reads it from its own directory", () => {
    expect(() => parseBuildSpec(demoSpec({ clone: "demo-repo" }))).toThrow(/clone: must be an absolute path/);
  });

  it("refuses a file with no front matter", () => {
    expect(() => parseBuildSpec("# just prose\n")).toThrow(/no YAML front matter/);
  });

  it("holds a slice back until every dependency has merged", () => {
    const spec = parseBuildSpec(demoSpec());

    expect(readySlices(spec.slices, new Set(), new Set()).map((slice) => slice.id)).toEqual(["shell"]);
    expect(readySlices(spec.slices, new Set(["shell"]), new Set()).map((slice) => slice.id)).toEqual(["panel"]);
  });
});

describe("the build-surface routes", () => {
  it("park the steps whose effect a restart cannot see (implement, fix, deploy) and repeat the rest", () => {
    const routes = buildSurfaceRoutes(fakeBuild().ports);

    const parked = routes.filter((route) => route.onRestart === "park").map((route) => route.match).sort();
    expect(parked).toEqual(["bs-deploy", "bs-fix", "bs-implement"]);
    expect(routes.map((route) => route.match).sort()).toEqual(Object.keys(DISPATCH_STEPS).sort());
  });

  it("declare exactly one step for each route and each owner gate", () => {
    const dispatch = BUILD_SURFACE_STEPS.filter((step) => step.kind === "dispatch").map((step) => step.id);
    const assisted = BUILD_SURFACE_STEPS.filter((step) => step.kind === "assisted").map((step) => step.id);

    expect(dispatch.sort()).toEqual(Object.keys(DISPATCH_STEPS).sort());
    expect(assisted).toEqual(["device-check", "deploy-approve", "final-walk"]);
  });
});
