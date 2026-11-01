import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { afterAll, describe, expect, it, vi } from "vitest";
import { defineWorkflow, dispatchStepIds } from "./definition.js";
import { openFactoryHost } from "./host.js";
import { entryFor } from "./registry/registry.js";
import { auditSteps } from "./registry/steps/audit.js";
import { buildSurfaceSteps } from "./registry/steps/build-surface.js";
import { coreSteps } from "./registry/steps/core.js";
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

/** TP-3106 S3: each reviewed READ row of core, build-surface and audit, and the class the review gave it. */
const S3_READ = ["update-backoff", "base-wait", "merge-settle", "await-new-head", "snapshot", "bs-plan", "bs-await-land", "audit-load", "audit-inventory-data"];
const S3_KEPT = ["bs-preflight", "bs-extract-check", "bs-report-check", "bs-gates", "bs-health", "bs-review-check", "audit-answerability", "audit-baseline"];

let dbs = 0;

/** A workflow that blocks on `orphan`, then runs a merge and a landing; `skip` makes a replay take the branch that never reaches it. */
function divergingWorkflow(family: string, orphan: string, skip: () => boolean) {
  return defineWorkflow({
    name: "diverging",
    steps: [{ id: family, kind: "dispatch" }, { id: "merge", kind: "dispatch" }, { id: "sh-landed", kind: "dispatch" }],
    run: async (ctx) => {
      if (!skip()) await ctx.dispatch(orphan, "wait");
      await ctx.dispatch("merge:r4:0", "merge");
      await ctx.dispatch("sh-landed", "landed");
    },
  });
}

const blockOn = (stuck: string, ids: readonly string[]): StepRoute[] => ids.map((match) => ({
  match,
  onRestart: "repeat",
  runner: { run: (input) => (input.stepId === stuck ? new Promise(() => undefined) : Promise.resolve({ ok: true, output: `${input.stepId} done` })) },
}));

async function finish(dbPath: string, workflow: ReturnType<typeof defineWorkflow>, runId?: string) {
  const host = openFactoryHost({ dbPath, workflows: [workflow], routes: blockOn("none", dispatchStepIds(workflow)) });
  try {
    await host.adopt();
    return await host.runtime.wait(runId ?? host.runtime.start(workflow.name));
  } finally {
    host.close();
  }
}

/** Blocks a run on `<family>:r3:0`, restarts the host, and replays down the branch that never reaches it. */
async function replayDivergedBefore(family: string) {
  const orphan = `${family}:r3:0`;
  let replaying = false;
  const workflow = divergingWorkflow(family, orphan, () => replaying);
  const dbPath = join(home, `diverged-${dbs++}.sqlite3`);
  const first = openFactoryHost({ dbPath, workflows: [workflow], routes: blockOn(orphan, dispatchStepIds(workflow)) });
  const runId = first.runtime.start(workflow.name);
  await vi.waitFor(() => expect(first.runtime.status(runId)?.activeSteps[orphan]).toBeDefined());
  first.close();
  replaying = true;
  const run = await finish(dbPath, workflow, runId);
  const control = await finish(join(home, `control-${dbs++}.sqlite3`), divergingWorkflow(family, orphan, () => true));
  return { run, orphan, controlKeys: Object.keys(control.stepResults).sort() };
}

function reasonOf(family: string): string {
  const effect = entryFor(factoryRegistry, family)?.effect;
  return effect && "reason" in effect ? detailOf(effect.reason) : "it has no reason";
}

describe("TP-3106 S3 READ review", () => {
  it("leaves no core, build-surface or audit entry pending review", () => {
    const pending = [...coreSteps, ...buildSurfaceSteps, ...auditSteps].filter((entry) => entry.effect.class === "pending");
    expect(pending.map((entry) => entry.name)).toEqual([]);
  });

  it.each(S3_READ)("a restart whose replay diverged before %s drops its orphan and the run continues, not parks", async (family) => {
    const { run, controlKeys } = await replayDivergedBefore(family);

    expect(run.status).toBe("completed");
    expect(run.activeSteps).toEqual({});
    expect(Object.keys(run.stepResults).sort()).toEqual(controlKeys);
  });

  it.each(S3_KEPT.map((family) => [family, reasonOf(family)]))("%s's orphan still parks because %s", async (family) => {
    const { run, orphan } = await replayDivergedBefore(family);

    expect(run.status).toBe("recovery_required");
    expect(run.error).toBe(`replay never reached recovered step ${orphan}`);
  });
});
