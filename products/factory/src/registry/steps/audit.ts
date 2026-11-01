import { step, effect, pending, READ, RECORD, WRITE } from "./helpers.js";

export const auditSteps = [
  step("audit-load", "dispatch", "software", pending(`${READ}: the audit's input and prior report`)),
  step("audit-inventory-data", "dispatch", "software", pending(`${READ}: the data store inventory`)),
  step("audit-inventory-code", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's code inventory`)),
  step("audit-purpose", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's purpose statement`)),
  step("audit-answerability", "dispatch", "software", pending(`${READ}: runs each declared surface once`)),
  step("audit-propose", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's proposal`)),
  step("audit-baseline", "dispatch", "software", pending(`${READ}: one baseline metric`)),
  step("audit-gaps", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's gap proposal`)),
  step("audit-plan", "dispatch", "AGENT", effect("item", `${RECORD}: an agent's surface plan`)),
  step("audit-publish", "dispatch", "software", effect("external", `${WRITE}: writes the audit report file`)),
];
