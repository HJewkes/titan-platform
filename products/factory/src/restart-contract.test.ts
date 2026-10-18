import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { afterAll, describe, expect, it } from "vitest";
import { dispatchStepIds, orphanSafe } from "./definition.js";
import { configuredRoutes, factoryWorkflows } from "./workflows.js";

/**
 * A `park` route with no `reconcile` hook leaves its run recovery_required on every restart that catches it, and the
 * restart drain waits on it. Each entry names the change that removes it; the hook itself arrives with TP-2339 slice Z1.
 */
const PARK_ROUTES_WITHOUT_RECONCILE: Readonly<Record<string, string>> = {};

const WRITE = "writes outside the run";
const RECORD = "records a fact a replay must read back, never recompute";
const READ = "read or wait whose result chose the branch taken; not yet reviewed for orphanSafe";

/**
 * Dispatch steps a replay that diverged before reaching them parks rather than drops. Dropping the orphan of a write
 * loses the record that the write happened; dropping a recorded fact lets a replay decide again on moved state.
 */
const RESTART_WRITE_STEPS: Readonly<Record<string, string>> = {
  "update-branch": `${WRITE}: updates the PR branch on GitHub`,
  "update-backoff": `${READ}: a sleep between update tries`,
  "base-wait": `${READ}: waits for the PR's base to be retargeted`,
  merge: `${WRITE}: merges the PR on GitHub`,
  "merge-policy": `${RECORD}: the merge policy in force at the merge`,
  "merge-settle": `${READ}: waits for the merge to settle`,
  "await-new-head": `${READ}: waits for a push to the PR head`,
  "post-merge": `${WRITE}: runs the configured post-merge chore`,
  snapshot: `${READ}: the PR snapshot the run branched on`,
  rerun: `${WRITE}: re-runs failed CI jobs on GitHub`,
  "sh-await-pr": `${READ}: waits for the registered PR to exist`,
  "sh-policy": `${RECORD}: the policy the run was registered with`,
  "sh-train-leave": `${WRITE}: takes the run out of the merge train`,
  "sh-wake-implementer": `${WRITE}: messages the implementer agent`,
  "sh-await-new-head": `${READ}: waits for the implementer's new head`,
  "sh-wake-fix-first": `${RECORD}: counts FIX_FIRST rounds`,
  "sh-repair": `${RECORD}: counts fixer wakes against the repair budget`,
  "sh-wake-fix-proof": `${RECORD}: counts fix-proof wakes against the bounce cap`,
  "sh-flake-check": `${READ}: whether failures fall outside the diff`,
  "sh-exit-notice": `${WRITE}: sends the exit notice`,
  "sh-park": `${WRITE}: parks the implementer's worktree`,
  "sh-fix-proof": `${READ}: waits for the fixer's proof`,
  "sh-review-intent": `${WRITE}: posts the review intent through the broker`,
  "sh-review": `${WRITE}: dispatches a reviewer agent`,
  "sh-await-verdict": `${RECORD}: the reviewer's verdict at a head`,
  "sh-late-verdict": `${RECORD}: a timed-out reviewer's verdict read once more`,
  "sh-correct-verdict": `${RECORD}: a corrected verdict`,
  "sh-seat-recheck": `${RECORD}: the seat check over a held MERGE`,
  "sh-merge-evidence": `${RECORD}: the merge evidence the merge relied on`,
  "sh-carry": `${RECORD}: a verdict carried across an unchanged tree`,
  "sh-publish-review": `${WRITE}: publishes the review check on GitHub`,
  "sh-account-hold": `${WRITE}: holds the run for account headroom`,
  "sh-account-wait": `${READ}: waits for account headroom`,
  "sh-review-request": `${READ}: whether Shepherd's own review was asked for`,
  "sh-review-stop": `${READ}: whether the review was stopped`,
  "sh-review-panel": `${RECORD}: the panel's aggregate verdict`,
  "sh-no-reviewer-hold": `${WRITE}: holds the run and alerts when no reviewer is wired`,
  "sh-no-reviewer-wait": `${READ}: waits for the no-reviewer hold to release`,
  "sh-carry-scope": `${RECORD}: the scope an approval carried over`,
  "sh-carry-seat": `${RECORD}: the seat an approval carried under`,
  "sh-remerge": `${RECORD}: a MERGE carried across a clean remerge`,
  "sh-approval-carry:fix": `${RECORD}: an approval carried across a small fix`,
  "sh-approval-carry:own": `${RECORD}: an approval carried across an own merge-up`,
  "sh-approval-carry": `${RECORD}: an approve-merge answer that followed the head`,
  "sh-merge-up": `${RECORD}: a MERGE carried across a clean merge-up`,
  "sh-release-preflight": `${READ}: the release's registry preflight`,
  "sh-release-follow": `${READ}: waits for the release's versions to publish`,
  "sh-main-ci": `${READ}: waits for main's CI after the merge`,
  "sh-stack-children": `${RECORD}: the stacked children listed after the parent landed`,
  "sh-restack": `${WRITE}: pushes a child's restack and retargets its base`,
  "sh-redeploy": `${WRITE}: starts a service deploy`,
  "sh-unfreeze": `${WRITE}: releases the repo freeze`,
  "sh-freeze": `${WRITE}: freezes the repo on a red main`,
  "sh-file-fix-task": `${WRITE}: files the fix task`,
  "sh-spawn-fixer": `${WRITE}: spawns the fixer agent`,
  "sh-thaw": `${WRITE}: releases the freeze for the owner`,
  "sh-cleanup": `${WRITE}: deletes the head ref and closes the task`,
  "sh-landed": `${RECORD}: the run's landed outcome`,
  "sh-stopped": `${RECORD}: the run's stopped outcome`,
  "sh-override": `${RECORD}: the owner's override and when it was taken`,
  "sh-conflict-check": `${READ}: whether the PR is mergeable`,
  "sh-freeze-hold": `${WRITE}: holds the run behind a freeze`,
  "sh-freeze-wait": `${READ}: waits for the freeze to thaw`,
  "sh-base-wait": `${READ}: waits for the base to move`,
  "sh-g10-release": `${WRITE}: releases the G10 adversary hold`,
  "sh-g10-rehold": `${WRITE}: re-places the G10 adversary hold`,
  "sh-seat-notice": `${WRITE}: sends the seat notice`,
  "sh-held-check": `${RECORD}: whether the run was held at this point`,
  "sh-held-wait": `${READ}: waits for a hold to release`,
  "sh-head-origin": `${RECORD}: who pushed the head`,
  "sh-review-refused": `${RECORD}: a standing MERGE re-read instead of a fresh review`,
  "sh-ci-unread": `${RECORD}: a CI-unread-only FIX_FIRST taken as no verdict`,
  "sh-visual-packet": `${WRITE}: spawns the review packager for a visual gate`,
  "audit-load": `${READ}: the audit's input and prior report`,
  "audit-inventory-data": `${READ}: the data store inventory`,
  "audit-inventory-code": `${RECORD}: an agent's code inventory`,
  "audit-purpose": `${RECORD}: an agent's purpose statement`,
  "audit-answerability": `${READ}: runs each declared surface once`,
  "audit-propose": `${RECORD}: an agent's proposal`,
  "audit-baseline": `${READ}: one baseline metric`,
  "audit-gaps": `${RECORD}: an agent's gap proposal`,
  "audit-plan": `${RECORD}: an agent's surface plan`,
  "audit-publish": `${WRITE}: writes the audit report file`,
};

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
  const ids = factoryWorkflows.flatMap((definition) => dispatchStepIds(definition).filter((id) => !orphanSafe(definition)(id)));
  return [...new Set(ids)];
}

describe("restart contract", () => {
  it("routes every production step repeat, or park with a reconcile hook, outside the reviewed exceptions", () => {
    expect(parkRoutesWithoutReconcile(productionRoutes()).sort()).toEqual(Object.keys(PARK_ROUTES_WITHOUT_RECONCILE).sort());
  });

  it("lists every dispatch step that is not orphan-safe in RESTART_WRITE_STEPS, and nothing else", () => {
    expect(unsafeDispatchSteps().sort()).toEqual(Object.keys(RESTART_WRITE_STEPS).sort());
  });

  it("gives every exception a reason of its own, beyond the shared category", () => {
    const blankParks = Object.entries(PARK_ROUTES_WITHOUT_RECONCILE).filter(([, reason]) => reason.trim() === "");
    const blankSteps = Object.entries(RESTART_WRITE_STEPS).filter(([, reason]) => !reason.includes(":") || detailOf(reason) === "");
    expect([...blankParks, ...blankSteps].map(([id]) => id)).toEqual([]);
  });
});
