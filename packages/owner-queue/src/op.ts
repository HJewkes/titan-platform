import { FreezeEndConditionSchema, OwnerIntentRefSchema } from "@titan-design/pm";
import { z } from "zod";
import { prKey, sessionKey } from "./keys.js";

const headSha = z.string().regex(/^[0-9a-f]{40}$/, "a 40-hex commit id");
const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "a GitHub <owner>/<repo>");
const pr = z.number().int().positive();
const name = z.string().min(1).max(200);
const planText = z.string().trim().min(1).max(2000);
const initiative = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "an initiative slug");
const planId = z.string().regex(/^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9-]*$/, "a plan record id such as alpha/B1");
const isoWeek = z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, "an ISO week such as 2026-W47");
/** The statement and measure an outcome edit replaces, as the owner read them back; the effect refuses when they moved. */
const outcomeText = z.strictObject({ statement: planText, measure: planText });
/** A freeze the owner sets: what it stops (one of tag or selector), why, until when, and where the owner said so. */
const freezeSet = z.strictObject({
  action: z.literal("set"),
  tag: planText.optional(),
  selector: planText.optional(),
  reason: planText,
  end_condition: FreezeEndConditionSchema,
  ...OwnerIntentRefSchema.shape,
});
const freezeEnd = z.strictObject({ action: z.literal("end"), id: planId });
const configPath = z.string().max(200).regex(/^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*$/, "a dotted config path");
/** A path the launching host reads as given: rooted at `/` or `~/`, never climbing with `..`, no control characters. */
const absPath = z
  .string()
  .max(512)
  .regex(/^(\/|~\/)/, "an absolute path, starting / or ~/")
  .refine((path) => !path.includes(".."), "a path with no ..")
  .refine((path) => ![...path].some(isControl), "a path with no control characters");

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}
/**
 * A session the owner starts from the console. The deposit only proposes it: the console pins the concrete account and
 * `briefSha256` into the record it writes, and the factory and broker refuse a record still naming `least-used` or no sha.
 */
const startSession = z.strictObject({
  kind: z.literal("start-session"),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "a session name"),
  profile: name,
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/, "a machine alias or hostname"),
  account: z.union([z.literal("least-used"), z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "an account profile name")]),
  cwd: absPath,
  surface: name,
  remoteControl: z.boolean(),
  briefPath: absPath,
  briefSha256: z.string().regex(/^[0-9a-f]{64}$/, "a 64-hex sha256").optional(),
});

export const HOLD_CLASSES = ["g10", "owner-asked"] as const;

/**
 * A merge-at-head that waits out a g10 hold: the owner approves now, and the merge goes through only once the adversary
 * loop closes with MERGE at the same head. Absent, the merge goes past the hold.
 */
export const MERGE_WAITS = ["adversary-loop"] as const;

/**
 * The typed target of an owner action. It names what to act on and is never authority: the
 * system of record re-reads every field at tap time, so a deposit that lies only gets `moved`.
 */
export const ownerOpSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("resolve-gate"), gateId: name, headSha, decision: name }),
  z.strictObject({ kind: z.literal("release-hold"), repo, pr, headSha, holdClass: z.enum(HOLD_CLASSES) }),
  z.strictObject({ kind: z.literal("merge-at-head"), repo, pr, headSha, waitFor: z.enum(MERGE_WAITS).optional() }),
  z.strictObject({ kind: z.literal("close-pr"), repo, pr, headSha }),
  z.strictObject({ kind: z.literal("factory-config-set"), path: configPath, value: z.json(), expectFrom: z.json().optional() }),
  z.strictObject({ kind: z.literal("deploy-pause-clear"), pausedAt: z.iso.datetime({ offset: true }), target: name }),
  z.strictObject({ kind: z.literal("retire-agent"), name, agentId: name, force: z.boolean() }),
  z.strictObject({ kind: z.literal("plan-bet-select"), initiative, week: isoWeek, bets: z.array(planId).min(1).max(20) }),
  z.strictObject({ kind: z.literal("plan-outcome-edit"), outcome: planId, to: outcomeText.partial(), from: outcomeText.optional() }),
  z.strictObject({ kind: z.literal("plan-freeze-set"), initiative, freeze: z.discriminatedUnion("action", [freezeSet, freezeEnd]) }),
  startSession,
]);

export type OwnerOp = z.infer<typeof ownerOpSchema>;
export type OwnerOpKind = OwnerOp["kind"];

/**
 * The merge keys an op implies, so an op about a PR joins that PR's hitl item at the same head, and two
 * deposits starting one session are one item. A gate op yields no `gate:` key: a deposit never claims to be the gate itself.
 */
export function opKeys(op: OwnerOp): string[] {
  if (op.kind === "start-session") return [sessionKey(op.name)];
  return "pr" in op ? [prKey(op.repo, op.pr, op.headSha)] : [];
}
