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
  "ci-orphan-rerun": `${WRITE}: re-runs a CI job left open under a completed workflow run`,
  "sh-await-pr": `${READ}: waits for the registered PR to exist`,
  "sh-policy": `${RECORD}: the policy the run was registered with`,
  "sh-train-leave": `${WRITE}: takes the run out of the merge train`,
  "sh-order-reserve": `${WRITE}: reserves a conflicted PR's paths in the merge order`,
  "sh-order-wait": `${WRITE}: leaves the merge train, then waits for the PRs merging ahead of the reservation`,
  "sh-order-unreserve": `${WRITE}: deletes the run's merge-order reservation`,
  "sh-order-expire": `${WRITE}: deletes the run's reservation past its TTL and logs order-expired, once`,
  "sh-wake-implementer": `${WRITE}: messages the implementer agent`,
  "sh-await-new-head": `${READ}: waits for the implementer's new head`,
  "sh-wake-fix-first": `${RECORD}: counts FIX_FIRST rounds`,
  "sh-repair": `${RECORD}: counts fixer wakes against the repair budget`,
  "sh-wake-fix-proof": `${RECORD}: counts fix-proof wakes against the bounce cap`,
  "sh-flake-check": `${READ}: whether failures fall outside the diff`,
  "sh-held-verdict": `${WRITE}: posts a held FIX_FIRST's findings as a PR comment, once per head by its marker`,
  "sh-exit-notice": `${WRITE}: sends the exit notice`,
  "sh-auto-pass": `${WRITE}: posts the audit comment for an owner gate a demotion rule passed`,
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
  "sh-fix-proof-waive": `${WRITE}: stores the owner's fix-proof waiver for a head`,
  "sh-fix-proof-waived": `${RECORD}: whether the owner waived a head's fix-proof`,
  "sh-no-reviewer-hold": `${WRITE}: holds the run and alerts when no reviewer is wired`,
  "sh-no-reviewer-wait": `${READ}: waits for the no-reviewer hold to release`,
  "sh-no-verdict-diagnosis": `${WRITE}: spawns the planner that diagnoses review rounds with no verdict; a planner already on the roster is not spawned again`,
  "sh-carry-scope": `${RECORD}: the scope an approval carried over`,
  "sh-carry-seat": `${RECORD}: the seat an approval carried under`,
  "sh-review-scope": `${RECORD}: the fix diff a fix-round re-review may read as scoped`,
  "sh-scope-check": `${RECORD}: a scoped fix round's out-of-range and repeated FIX_FIRST items`,
  "sh-review-shadow": `${RECORD}: what review-workflow would have decided at a round, read once with the installed profiles`,
  "sh-remerge": `${RECORD}: a MERGE carried across a clean remerge`,
  "sh-approval-carry:fix": `${RECORD}: an approval carried across a small fix`,
  "sh-approval-carry:own": `${RECORD}: an approval carried across an own merge-up`,
  "sh-approval-carry:set": `${RECORD}: a visual approval carried by the owner's accepted set`,
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
  "sh-main-rerun": `${WRITE}: reruns main's failed jobs once and may thaw`,
  "sh-spawn-fixer": `${WRITE}: spawns the fixer agent`,
  "sh-thaw": `${WRITE}: releases the freeze for the owner`,
  "sh-cleanup": `${WRITE}: deletes the head ref and closes the task`,
  "sh-landed": `${RECORD}: the run's landed outcome`,
  "sh-stopped": `${RECORD}: the run's stopped outcome`,
  "sh-override": `${RECORD}: the owner's override and when it was taken`,
  "sh-conflict-check": `${READ}: whether the PR is mergeable`,
  "sh-conflict-base": `${RECORD}: the base sha at a conflict and whether the head merged the last one`,
  "sh-stale-base": `${READ}: whether a red ran on a base the PR left or that no longer exists`,
  "sh-merge-main": `${READ}: whether main changed a guard file or turned green since the PR's merge base`,
  "sh-freeze-hold": `${WRITE}: holds the run behind a freeze`,
  "sh-freeze-wait": `${READ}: waits for the freeze to thaw`,
  "sh-base-wait": `${READ}: waits for the base to move`,
  "sh-fix-pr-stall": `${RECORD}: whether a thaw wait holds an unmarked fix-task PR`,
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
  "bs-plan": `${READ}: the build spec the slices come from`,
  "bs-preflight": `${READ}: the repo's preflight verdict for a slice`,
  "bs-extract": `${RECORD}: an agent's extracted targets`,
  "bs-extract-check": `${READ}: the repo's verdict on the targets`,
  "bs-branch": `${WRITE}: creates the slice branch on GitHub`,
  "bs-implement": `${WRITE}: spawns the slice implementer`,
  "bs-report-check": `${READ}: the verdict on an implementer's report`,
  "bs-gates": `${READ}: runs the repo's gates at a head`,
  "bs-health": `${READ}: the repo's health probe before an infra rerun`,
  "bs-file-task": `${WRITE}: files the task for a broken gate or spec`,
  "bs-preview": `${WRITE}: syncs the preview at a head`,
  "bs-review": `${WRITE}: dispatches the slice reviewer`,
  "bs-review-check": `${READ}: the verdict on a review`,
  "bs-fix": `${WRITE}: resumes the implementer for a fix round`,
  "bs-pr": `${WRITE}: opens the slice PR`,
  "bs-shepherd": `${WRITE}: registers the PR with Shepherd`,
  "bs-await-land": `${READ}: waits for Shepherd to land the PR`,
  "bs-deploy": `${WRITE}: runs the repo's deploy at the merge`,
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
