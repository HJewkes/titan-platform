import { step, READ_EFFECT, effect, RECORD, RUNS, WRITE } from "./helpers.js";

export const auditSteps = [
  step("audit-load", "dispatch", "software", READ_EFFECT),
  step("audit-inventory-data", "dispatch", "software", READ_EFFECT),
  step("audit-inventory-code", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's code inventory`)),
  step("audit-purpose", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's purpose statement`)),
  step("audit-answerability", "dispatch", "software", effect("external", `${RUNS}: runs each declared surface command once, so re-running repeats its side effects`)),
  step("audit-propose", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's proposal`)),
  step("audit-baseline", "dispatch", "software", effect("external", `${RUNS}: a cli metric runs the store's declared command with the metric's own arguments`)),
  step("audit-gaps", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's gap proposal`)),
  step("audit-plan", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's surface plan`)),
  step("audit-publish", "dispatch", "software", effect("external", `${WRITE}: writes the audit report file`)),
];
