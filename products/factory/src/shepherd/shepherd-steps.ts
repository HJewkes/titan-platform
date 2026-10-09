import type { StepDeclaration } from "../definition.js";
import { LAND_STEPS } from "../workflows/land.js";
import { AWAIT_HEAD_STEPS } from "../workflows/await-head.js";
import { WAKE_STEPS } from "./wake.js";
import { PARK_STEPS } from "./park.js";
import { REVIEW_STEPS } from "./review.js";
import { CARRY_SCOPE_STEPS } from "./carry-merge.js";
import { RELEASE_STEPS } from "./release.js";
import { POST_MERGE_STEPS } from "./post-merge.js";
import { OBSERVE_STEPS } from "./observe.js";
import { OUTCOME_STEPS } from "./outcome.js";
import { CONFLICT_CHECK_STEPS } from "./conflict-check.js";
import { FREEZE_HOLD_STEPS } from "./freeze-hold.js";
import { G10_RELEASE_STEPS } from "./g10-release.js";
import { SEAT_NOTICE_STEPS } from "./gate-route.js";

/** Steps shared with land-pr are declared here too; their routes are registered once, in `factoryRoutes`. */
export const SHEPHERD_STEPS: readonly StepDeclaration[] = [
  ...LAND_STEPS,
  ...AWAIT_HEAD_STEPS,
  { id: "rerun", kind: "dispatch" },
  { id: "ci-failed", kind: "assisted" },
  { id: "sh-await-pr", kind: "dispatch" },
  { id: "sh-policy", kind: "dispatch" },
  { id: "sh-sent-back", kind: "assisted" },
  { id: "sh-train-leave", kind: "dispatch" },
  ...WAKE_STEPS,
  ...PARK_STEPS,
  ...REVIEW_STEPS,
  ...CARRY_SCOPE_STEPS,
  ...RELEASE_STEPS,
  ...POST_MERGE_STEPS,
  ...OBSERVE_STEPS,
  ...OUTCOME_STEPS,
  ...CONFLICT_CHECK_STEPS,
  ...FREEZE_HOLD_STEPS,
  ...G10_RELEASE_STEPS,
  ...SEAT_NOTICE_STEPS,
];
