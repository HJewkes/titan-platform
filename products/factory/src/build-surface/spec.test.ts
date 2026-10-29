import { describe, expect, it } from "vitest";
import { partialFake } from "@titan-design/test-kit";
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

  it("refuses a slice id whose last reviewer name would pass agent-chat's 64 characters, and takes it with no reviewer", () => {
    const long = { repo: "owner/a-very-long-repository-name", slices: [{ id: `s${"x".repeat(39)}`, title: "A", brief: "b" }] };

    expect(() => parseBuildSpec(demoSpec(long))).toThrow(`gives the agent name "bs-a-very-long-reposito-s${"x".repeat(39)}-rv12", over agent-chat's 64 characters`);
    expect(parseBuildSpec(demoSpec({ ...long, reviewer: undefined })).slices).toHaveLength(1);
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

  it("tell the owner a parked implement step resumes as a new turn, not a re-read of the old report", async () => {
    const implement = buildSurfaceRoutes(fakeBuild().ports).find((route) => route.match === "bs-implement")!;

    const recovery = await implement.reconcile!(partialFake(), new AbortController().signal);

    expect(recovery).toEqual({ kind: "unknown", evidence: expect.stringMatching(/starts a new implement turn with the full brief and takes only a report written after it/) });
    expect(recovery).not.toEqual(expect.objectContaining({ evidence: expect.stringMatching(/read again/) }));
  });

  it("declare exactly one step for each route and each owner gate", () => {
    const dispatch = BUILD_SURFACE_STEPS.filter((step) => step.kind === "dispatch").map((step) => step.id);
    const assisted = BUILD_SURFACE_STEPS.filter((step) => step.kind === "assisted").map((step) => step.id);

    expect(dispatch.sort()).toEqual(Object.keys(DISPATCH_STEPS).sort());
    expect(assisted).toEqual(["device-check", "deploy-approve", "final-walk"]);
  });
});
