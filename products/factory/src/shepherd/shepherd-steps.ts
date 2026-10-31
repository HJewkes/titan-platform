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
import { CONFLICT_BASE_STEPS } from "./conflict-base.js";
import { STALE_BASE_STEPS } from "./stale-base.js";
import { MERGE_MAIN_STEPS } from "./merge-main.js";
import { MERGE_ORDER_STEPS } from "./merge-order-steps.js";
import { FREEZE_HOLD_STEPS } from "./freeze-hold.js";
import { FIX_PR_STALL_STEPS } from "./fix-pr-stall.js";
import { G10_RELEASE_STEPS } from "./g10-release.js";
import { G10_REHOLD_STEPS } from "./g10-rehold.js";
import { SEAT_NOTICE_STEPS } from "./gate-route.js";
import { HELD_REPAIR_STEPS } from "./held-repair.js";
import { HEAD_ORIGIN_STEPS } from "./head-origin.js";
import { REVIEW_REFUSED_STEPS } from "./merge-standing.js";
import { VISUAL_PACKET_STEPS } from "./visual-packet-trigger.js";
import { OWNER_SEND_BACK_STEPS } from "./owner-send-back.js";
import { VISUAL_ACCEPT_STEPS } from "./visual-accept.js";
import { AUTO_PASS_STEPS } from "./auto-pass.js";
import { DIAGNOSIS_STEPS } from "./no-verdict-diagnosis.js";

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
  ...CONFLICT_BASE_STEPS,
  ...STALE_BASE_STEPS,
  ...MERGE_MAIN_STEPS,
  ...MERGE_ORDER_STEPS,
  ...FREEZE_HOLD_STEPS,
  ...FIX_PR_STALL_STEPS,
  ...G10_RELEASE_STEPS,
  ...G10_REHOLD_STEPS,
  ...SEAT_NOTICE_STEPS,
  ...HELD_REPAIR_STEPS,
  ...HEAD_ORIGIN_STEPS,
  ...REVIEW_REFUSED_STEPS,
  ...VISUAL_PACKET_STEPS,
  ...OWNER_SEND_BACK_STEPS,
  ...VISUAL_ACCEPT_STEPS,
  ...AUTO_PASS_STEPS,
  ...DIAGNOSIS_STEPS,
];
