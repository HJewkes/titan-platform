import { step, READ_EFFECT, effect, RECORD, WRITE } from "./helpers.js";

export const coreSteps = [
  step("land-rules", "dispatch", "software", READ_EFFECT),
  step("ci-orphan-rerun", "dispatch", "software", effect("pr", `${WRITE}: re-runs a CI job left open under a completed workflow run`)),
  step("update-branch", "dispatch", "software", effect("pr", `${WRITE}: updates the PR branch on GitHub`)),
  step("update-backoff", "dispatch", "software", READ_EFFECT),
  step("base-check", "dispatch", "software", READ_EFFECT),
  step("base-wait", "dispatch", "software", READ_EFFECT),
  step("merge-policy", "dispatch", "software", effect("item", `${RECORD}: the merge policy in force at the merge`)),
  step("merge-settle", "dispatch", "software", READ_EFFECT),
  step("await-new-head", "dispatch", "software", READ_EFFECT),
  step("post-merge", "dispatch", "software", effect("external", `${WRITE}: runs the configured post-merge chore`)),
  step("snapshot", "dispatch", "software", READ_EFFECT),
  step("rerun", "dispatch", "software", effect("pr", `${WRITE}: re-runs failed CI jobs on GitHub`)),
];
