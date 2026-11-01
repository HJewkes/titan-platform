import { step, effect } from "./helpers.js";

export const gateSteps = [
  step("approve-merge", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("stuck-behind", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("ci-failed", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("sh-sent-back", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("sh-merge-evidence-gate", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("main-red", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("main-ci-timeout", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("main-red-again", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("main-frozen", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("after-stages", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("sh-visual-accept", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("audit-review", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("device-confirm", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("device-check", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("infra-park", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("deploy-approve", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
  step("final-walk", "assisted", "OWNER", effect("item", "an owner gate: the answer is recorded once and a replay reads it back")),
];
