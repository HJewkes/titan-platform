import { step, READ_EFFECT, effect, irreversible, pending, READ, RECORD, WRITE } from "./helpers.js";

export const coreSteps = [
  step("land-rules", "dispatch", "software", READ_EFFECT),
  step("ci-wait", "dispatch", "software", READ_EFFECT),
  step("ci-orphan-rerun", "dispatch", "software", effect("pr", `${WRITE}: re-runs a CI job left open under a completed workflow run`)),
  step("update-branch", "dispatch", "software", effect("pr", `${WRITE}: updates the PR branch on GitHub`)),
  step("update-backoff", "dispatch", "software", pending(`${READ}: a sleep between update tries`)),
  step("base-check", "dispatch", "software", READ_EFFECT),
  step("base-wait", "dispatch", "software", pending(`${READ}: waits for the PR's base to be retargeted`)),
  step("merge", "dispatch", "software", irreversible("pr", `${WRITE}: merges the PR on GitHub`)),
  step("merge-policy", "dispatch", "software", effect("item", `${RECORD}: the merge policy in force at the merge`)),
  step("merge-settle", "dispatch", "software", pending(`${READ}: waits for the merge to settle`)),
  step("await-new-head", "dispatch", "software", pending(`${READ}: waits for a push to the PR head`)),
  step("post-merge", "dispatch", "software", effect("external", `${WRITE}: runs the configured post-merge chore`)),
  step("snapshot", "dispatch", "software", pending(`${READ}: the PR snapshot the run branched on`)),
  step("rerun", "dispatch", "software", effect("pr", `${WRITE}: re-runs failed CI jobs on GitHub`)),
];
