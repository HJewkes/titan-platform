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

/**
 * An oracle that does not come from the registry: the write and record steps the pre-registry list named (the 86 that
 * are not reads), so reclassifying one as `read` fails here instead of silently dropping its orphan on restart.
 * Reclassifying a reviewed read as an effect (TP-3106 S3, S4) adds its id.
 */
const PINNED_PARKING_STEPS: readonly string[] = [
  "audit-gaps", "audit-inventory-code", "audit-plan", "audit-propose", "audit-publish", "audit-purpose", "bs-branch", "bs-deploy", "bs-extract", "bs-file-task", "bs-fix", "bs-implement", "bs-pr", "bs-preview", "bs-review", "bs-shepherd", "ci-orphan-rerun", "merge", "merge-policy", "post-merge", "rerun", "sh-account-hold", "sh-approval-carry", "sh-approval-carry:fix", "sh-approval-carry:own", "sh-approval-carry:set", "sh-auto-pass", "sh-await-verdict", "sh-carry", "sh-carry-scope", "sh-carry-seat", "sh-ci-unread", "sh-cleanup", "sh-conflict-base", "sh-correct-verdict", "sh-exit-notice", "sh-file-fix-task", "sh-fix-pr-stall", "sh-fix-proof-waive", "sh-fix-proof-waived", "sh-freeze", "sh-freeze-hold", "sh-g10-rehold", "sh-g10-release", "sh-head-origin", "sh-held-check", "sh-held-verdict", "sh-landed", "sh-late-verdict", "sh-main-rerun", "sh-merge-evidence", "sh-merge-up", "sh-no-reviewer-hold", "sh-no-verdict-diagnosis", "sh-order-expire", "sh-order-reserve", "sh-order-unreserve", "sh-order-wait", "sh-override", "sh-park", "sh-policy", "sh-publish-review", "sh-redeploy", "sh-remerge", "sh-repair", "sh-restack", "sh-review", "sh-review-intent", "sh-review-panel", "sh-review-refused", "sh-review-scope", "sh-review-shadow", "sh-scope-check", "sh-seat-notice", "sh-seat-recheck", "sh-spawn-fixer", "sh-stack-children", "sh-stopped", "sh-thaw", "sh-train-leave", "sh-unfreeze", "sh-visual-packet", "sh-wake-fix-first", "sh-wake-fix-proof", "sh-wake-implementer", "update-branch",
];

const PINNED_IRREVERSIBLE_STEPS: readonly string[] = ["bs-deploy", "merge", "sh-cleanup", "sh-publish-review", "sh-redeploy"];

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

  it("every pinned write or record step is an effect, and no other step is", () => {
    const effects = factoryRegistry.entries.filter((e) => e.op === "dispatch" && (e.effect.class === "effect" || e.effect.class === "irreversible"));
    expect(effects.map((e) => e.name).sort()).toEqual([...PINNED_PARKING_STEPS].sort());
    expect(effects.filter((e) => e.effect.class === "irreversible").map((e) => e.name).sort()).toEqual([...PINNED_IRREVERSIBLE_STEPS]);
  });

  it("gives every exception a reason of its own, beyond the shared category", () => {
    const blankParks = Object.entries(PARK_ROUTES_WITHOUT_RECONCILE).filter(([, reason]) => reason.trim() === "");
    const blankSteps = Object.entries(RESTART_WRITE_STEPS).filter(([, reason]) => !reason.includes(":") || detailOf(reason) === "");
    expect([...blankParks, ...blankSteps].map(([id]) => id)).toEqual([]);
  });
});
