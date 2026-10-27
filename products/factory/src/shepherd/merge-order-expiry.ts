// superseded-at:M3 (D-M3-19: M3's merge queue must carry merge-order.json, TP-3147)
import type { RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import { noticeHeldSeat } from "./gate-route.js";
import type { GateRun } from "./gates.js";
import { EXPIRE_STEP, replayingWithout, type OrderRun } from "./merge-order-steps.js";
import { withinTtl, type MergeOrder, type MergeOrderRules } from "./merge-order.js";

const ExpireResult = z.looseObject({ expired: z.boolean(), ttlMinutes: z.number().optional() });
type Expired = z.infer<typeof ExpireResult>;

interface ExpiryDeps {
  order: () => MergeOrder;
  rules: MergeOrderRules;
  now: () => number;
}

/** Ends the run's own reservation once it is past the TTL; a reservation already ended, or still live, ends nothing. */
function expireOwn(deps: ExpiryDeps, input: { repo: RepoSlug; runId: string }): Expired {
  const rule = deps.rules(input.repo);
  const own = deps.order().list(input.repo).find((reservation) => reservation.runId === input.runId);
  if (!rule?.enabled || own === undefined || withinTtl(own, rule, deps.now())) return { expired: false };
  return { expired: deps.order().expire(input.repo, input.runId, own.since, new Date(deps.now()).toISOString()), ttlMinutes: rule.ttlMinutes };
}

export const orderExpiryRoute = (deps: ExpiryDeps): StepRoute => codeRoute(EXPIRE_STEP, deps.now, async (input: { repo: RepoSlug; runId: string }) => expireOwn(deps, input));

/**
 * Read on each CI read while the run holds a reservation (TP-4098 D). One past its TTL stops ordering anyone, so it is
 * logged `order-expired` once and the run's seat hears once that overlapping PRs may now land first and re-conflict it.
 */
export async function expireOrder(run: OrderRun & GateRun, headSha: string): Promise<void> {
  if (!run.reserved || replayingWithout(run.ctx, EXPIRE_STEP)) return;
  const result = await step(run.ctx, EXPIRE_STEP, { repo: run.target.repo, runId: run.ctx.runId }, ExpireResult);
  if (!result.expired) return;
  run.reserved = false;
  const why = `merge order: its reservation passed the ${result.ttlMinutes ?? "?"} min TTL unlanded, so overlapping PRs no longer wait behind it`;
  await noticeHeldSeat(run, JSON.stringify(["order-expired", headSha]), { headSha, why, gate: "order-expired" });
}
