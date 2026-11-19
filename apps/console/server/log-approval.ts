/**
 * How a merged PR was approved, read from its Shepherd timeline (TP-6775). A release Shepherd decided by rule records a
 * `decision` entry with that rule; an owner tap resolves the approve-merge gate as `owner:<id>`. A run that recorded
 * neither reads as `unrecorded`, never as the owner's, so the log does not claim a tap that did not happen. An auto-by-rec
 * merge is told by Shepherd's by-rec row, not here.
 */
import { z } from "zod";
import type { Approval } from "./log-rows.js";

const decisionEntry = z.object({ kind: z.literal("decision"), rule: z.string() }).passthrough();
const gateEntry = z.object({ kind: z.literal("gate"), stepId: z.string(), status: z.string(), resolvedBy: z.string().nullable() }).passthrough();

const PLAN_RULE = /plan/i;
const REVIEWER_RULE = /^MRG-AU-R/;

export interface ApprovalRead {
  approval: Approval;
  rule?: string;
}

export function approvalOf(entries: readonly unknown[]): ApprovalRead {
  const rules = entries.flatMap((entry) => decisionEntry.safeParse(entry).data?.rule ?? []);
  const plan = rules.find((rule) => PLAN_RULE.test(rule));
  if (plan !== undefined) return { approval: "plan", rule: plan };
  const gates = entries.flatMap((entry) => gateEntry.safeParse(entry).data ?? []);
  const ownerTap = gates.some((gate) => gate.stepId === "approve-merge" && gate.status === "resolved" && gate.resolvedBy?.startsWith("owner:") === true);
  if (ownerTap) return { approval: "owner" };
  const reviewer = rules.find((rule) => REVIEWER_RULE.test(rule));
  return reviewer === undefined ? { approval: "unrecorded" } : { approval: "reviewer", rule: reviewer };
}
