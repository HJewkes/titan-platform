import { z } from "zod";
import { prKey } from "./keys.js";

const headSha = z.string().regex(/^[0-9a-f]{40}$/, "a 40-hex commit id");
const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "a GitHub <owner>/<repo>");
const pr = z.number().int().positive();
const name = z.string().min(1).max(200);
const configPath = z.string().max(200).regex(/^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*$/, "a dotted config path");

export const HOLD_CLASSES = ["g10", "owner-asked"] as const;

/**
 * The typed target of an owner action. It names what to act on and is never authority: the
 * system of record re-reads every field at tap time, so a deposit that lies only gets `moved`.
 */
export const ownerOpSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("resolve-gate"), gateId: name, headSha, decision: name }),
  z.strictObject({ kind: z.literal("release-hold"), repo, pr, headSha, holdClass: z.enum(HOLD_CLASSES) }),
  z.strictObject({ kind: z.literal("merge-at-head"), repo, pr, headSha }),
  z.strictObject({ kind: z.literal("close-pr"), repo, pr, headSha }),
  z.strictObject({ kind: z.literal("factory-config-set"), path: configPath, value: z.json(), expectFrom: z.json().optional() }),
  z.strictObject({ kind: z.literal("deploy-pause-clear"), pausedAt: z.iso.datetime({ offset: true }), target: name }),
  z.strictObject({ kind: z.literal("retire-agent"), name, agentId: name, force: z.boolean() }),
]);

export type OwnerOp = z.infer<typeof ownerOpSchema>;
export type OwnerOpKind = OwnerOp["kind"];

/**
 * The merge keys an op implies, so an op about a PR joins that PR's hitl item at the same head.
 * A gate op yields no `gate:` key: a deposit never claims to be the gate itself.
 */
export function opKeys(op: OwnerOp): string[] {
  return "pr" in op ? [prKey(op.repo, op.pr, op.headSha)] : [];
}
