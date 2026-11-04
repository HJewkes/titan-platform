import { step, READ_EFFECT, effect, irreversible, RECORD, RUNS, WRITE } from "./helpers.js";

export const buildSurfaceSteps = [
  step("bs-plan", "dispatch", "software", READ_EFFECT),
  step("bs-preflight", "dispatch", "software", effect("external", `${RUNS}: the repo's preflight argv for a slice, through the runner bs-preview and bs-deploy write through`)),
  step("bs-extract", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's extracted targets`)),
  step("bs-extract-check", "dispatch", "software", effect("external", `${RUNS}: the repo's extract validator argv, fed the targets on stdin`)),
  step("bs-branch", "dispatch", "software", effect("commit", `${WRITE}: creates the slice branch on GitHub`)),
  step("bs-implement", "dispatch", "AGENT", effect("external", `${WRITE}: spawns the slice implementer`)),
  step("bs-report-check", "dispatch", "software", effect("external", `${RUNS}: the repo's report validator argv, after reading the remote head`)),
  step("bs-gates", "dispatch", "software", effect("external", `${RUNS}: the repo's gate argv, which writes the gate evidence records the step then reads`)),
  step("bs-health", "dispatch", "software", effect("external", `${RUNS}: the repo's health probe argv before an infra rerun`)),
  step("bs-file-task", "dispatch", "software", effect("item", `${WRITE}: files the task for a broken gate or spec`)),
  step("bs-preview", "dispatch", "software", effect("external", `${WRITE}: syncs the preview at a head`)),
  step("bs-review", "dispatch", "AGENT", effect("external", `${WRITE}: dispatches the slice reviewer`)),
  step("bs-review-check", "dispatch", "software", effect("external", `${RUNS}: the repo's review validator argv, fed the review on stdin`)),
  step("bs-fix", "dispatch", "AGENT", effect("external", `${WRITE}: resumes the implementer for a fix round`)),
  step("bs-pr", "dispatch", "software", effect("pr", `${WRITE}: opens the slice PR`)),
  step("bs-shepherd", "dispatch", "software", effect("external", `${WRITE}: registers the PR with Shepherd`)),
  step("bs-await-land", "dispatch", "software", READ_EFFECT),
  step("bs-deploy", "dispatch", "software", irreversible("external", `${WRITE}: runs the repo's deploy at the merge`)),
];
