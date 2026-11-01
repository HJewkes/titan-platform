import { step, effect, irreversible, pending, READ, RECORD, WRITE } from "./helpers.js";

export const buildSurfaceSteps = [
  step("bs-plan", "dispatch", "software", pending(`${READ}: the build spec the slices come from`)),
  step("bs-preflight", "dispatch", "software", pending(`${READ}: the repo's preflight verdict for a slice`)),
  step("bs-extract", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's extracted targets`)),
  step("bs-extract-check", "dispatch", "software", pending(`${READ}: the repo's verdict on the targets`)),
  step("bs-branch", "dispatch", "software", effect("commit", `${WRITE}: creates the slice branch on GitHub`)),
  step("bs-implement", "dispatch", "AGENT", effect("external", `${WRITE}: spawns the slice implementer`)),
  step("bs-report-check", "dispatch", "software", pending(`${READ}: the verdict on an implementer's report`)),
  step("bs-gates", "dispatch", "software", pending(`${READ}: runs the repo's gates at a head`)),
  step("bs-health", "dispatch", "software", pending(`${READ}: the repo's health probe before an infra rerun`)),
  step("bs-file-task", "dispatch", "software", effect("item", `${WRITE}: files the task for a broken gate or spec`)),
  step("bs-preview", "dispatch", "software", effect("external", `${WRITE}: syncs the preview at a head`)),
  step("bs-review", "dispatch", "AGENT", effect("external", `${WRITE}: dispatches the slice reviewer`)),
  step("bs-review-check", "dispatch", "software", pending(`${READ}: the verdict on a review`)),
  step("bs-fix", "dispatch", "AGENT", effect("external", `${WRITE}: resumes the implementer for a fix round`)),
  step("bs-pr", "dispatch", "software", effect("pr", `${WRITE}: opens the slice PR`)),
  step("bs-shepherd", "dispatch", "software", effect("external", `${WRITE}: registers the PR with Shepherd`)),
  step("bs-await-land", "dispatch", "software", pending(`${READ}: waits for Shepherd to land the PR`)),
  step("bs-deploy", "dispatch", "software", irreversible("external", `${WRITE}: runs the repo's deploy at the merge`)),
];
