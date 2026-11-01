import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { afterAll, describe, expect, it } from "vitest";
import { dispatchStepIds } from "./definition.js";
import { entryFor } from "./registry/registry.js";
import { abandonsOrphan, factoryRegistry } from "./registry/steps/index.js";
import { configuredRoutes, factoryWorkflows } from "./workflows.js";

/**
 * A `park` route with no `reconcile` hook leaves its run recovery_required on every restart that catches it, and the
 * restart drain waits on it. Each entry names the change that removes it; the hook itself arrives with TP-2339 slice Z1.
 */
const PARK_ROUTES_WITHOUT_RECONCILE: Readonly<Record<string, string>> = {};

/**
 * Dispatch steps a replay that diverged before reaching them parks rather than drops. Dropping the orphan of a write
 * loses the record that the write happened; dropping a recorded fact lets a replay decide again on moved state.
 * The registry holds the classification; this is its non-read dispatch entries, until the list is deleted at D-M3-19.
 */
const RESTART_WRITE_STEPS: Readonly<Record<string, string>> = Object.fromEntries(
  factoryRegistry.entries.flatMap((entry) => (entry.op === "dispatch" && entry.effect.class !== "read" ? [[entry.name, entry.effect.reason]] : [])),
);

const home = mkdtempSync(join(tmpdir(), "restart-contract-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The route set `serve` runs, built over an empty config home and a fake GitHub so nothing leaves the test. */
function productionRoutes(): readonly StepRoute[] {
  return configuredRoutes({ XDG_CONFIG_HOME: home, XDG_STATE_HOME: join(home, "state") }, { port: githubPort(fakeGitHub().wire) });
}

/** Read loosely: the `reconcile` hook is not on `StepRoute` until TP-2339 slice Z1 releases it. */
const hasReconcile = (route: StepRoute): boolean => "reconcile" in route && typeof route.reconcile === "function";

function parkRoutesWithoutReconcile(routes: readonly StepRoute[]): string[] {
  return routes.filter((route) => route.onRestart === "park" && !hasReconcile(route)).map((route) => route.match);
}

/** The text after the category prefix, which is what names this step's own effect. */
const detailOf = (reason: string): string => reason.slice(reason.indexOf(":") + 1).trim();

function unsafeDispatchSteps(): string[] {
  const ids = factoryWorkflows.flatMap((definition) => dispatchStepIds(definition).filter((id) => !abandonsOrphan(id)));
  return [...new Set(ids)];
}

describe("restart contract", () => {
  it("routes every production step repeat, or park with a reconcile hook, outside the reviewed exceptions", () => {
    expect(parkRoutesWithoutReconcile(productionRoutes()).sort()).toEqual(Object.keys(PARK_ROUTES_WITHOUT_RECONCILE).sort());
  });

  it("lists every dispatch step that is not orphan-safe in RESTART_WRITE_STEPS, and nothing else", () => {
    expect(unsafeDispatchSteps().sort()).toEqual(Object.keys(RESTART_WRITE_STEPS).sort());
  });

  it("a dispatch step's orphan is dropped exactly when its registry effect class is read", () => {
    const dispatchIds = factoryWorkflows.flatMap((definition) => dispatchStepIds(definition));
    const dropped = dispatchIds.filter((id) => entryFor(factoryRegistry, id)?.effect.class === "read");
    expect([...new Set(dispatchIds.filter(abandonsOrphan))].sort()).toEqual([...new Set(dropped)].sort());
    expect(dropped.length).toBeGreaterThan(0);
  });

  it("gives every exception a reason of its own, beyond the shared category", () => {
    const blankParks = Object.entries(PARK_ROUTES_WITHOUT_RECONCILE).filter(([, reason]) => reason.trim() === "");
    const blankSteps = Object.entries(RESTART_WRITE_STEPS).filter(([, reason]) => !reason.includes(":") || detailOf(reason) === "");
    expect([...blankParks, ...blankSteps].map(([id]) => id)).toEqual([]);
  });
});
