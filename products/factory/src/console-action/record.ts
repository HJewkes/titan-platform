import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { ownerOpSchema, type OwnerOp } from "@titan-design/owner-queue";
import { z } from "zod";
import { CiPolicyScopeSchema, PathScopeSchema } from "../shepherd/plan-approval.js";
import { refused, type Outcome } from "./outcome.js";

export const MAX_ACTION_RECORD_BYTES = 64 * 1024;
/** O_NONBLOCK so a planted FIFO cannot hang the open; O_NOFOLLOW so a symlinked record is refused, not followed. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));
const GateActionSchema = z.strictObject({
  kind: z.literal("resolve-gate"),
  gateId: z.string().min(1).max(512),
  runId: z.string().min(1).max(256),
  stepId: z.string().min(1).max(256),
  repo: z.string().min(1).max(256),
  pr: z.number().int().positive(),
  headSha: hex(40),
  /** Any option id reads; `gate.ts` refuses one off the step's allowlist or the gate's schema as `class`, not `record`. */
  decision: z.string().regex(/^[a-z][a-z-]{0,63}$/),
});
/** No resolver field: the release is always the console's owner-remote, whatever else the record says. */
const ReleaseActionSchema = z.strictObject({
  kind: z.literal("owner-release"),
  repo: z.string().min(1).max(256),
  pr: z.number().int().positive(),
  headSha: hex(40),
});
/** The owner's plan-time answer; no actor field, so the row's actor is always the console's owner-remote. */
const planApprovalFields = { kind: z.literal("plan-approval"), task: z.string().min(1).max(256), repo: z.string().min(1).max(256), round: z.string().min(1).max(512) };
const PlanApprovalActionSchema = z.discriminatedUnion("gate", [
  z.strictObject({ ...planApprovalFields, gate: z.literal("ci-policy"), scope: CiPolicyScopeSchema }),
  z.strictObject({ ...planApprovalFields, gate: z.enum(["skill", "visual"]), scope: PathScopeSchema }),
]);
/** The console writes the rest of the record (read-back, digest, session, peer class); the factory reads only the action. */
const ActionRecord = z.looseObject({ action: z.discriminatedUnion("kind", [GateActionSchema, ReleaseActionSchema, PlanApprovalActionSchema]) });
/** A record names an action or an op, never both, so one record can never be read two ways. */
const OpRecord = z.looseObject({ op: ownerOpSchema, action: z.never().optional() });

export type GateAction = z.infer<typeof GateActionSchema>;
export type ReleaseAction = z.infer<typeof ReleaseActionSchema>;
export type PlanApprovalAction = z.infer<typeof PlanApprovalActionSchema>;

/** One record as read: the action its bytes name and the sha256 of those exact bytes. */
export interface Read<A = GateAction | ReleaseAction | PlanApprovalAction> {
  action: A;
  confirmEvent: string;
}

export interface OpRead {
  op: OwnerOp;
  confirmEvent: string;
}

/** A missing record is `gone`: the console never wrote it, or it was cleaned up. Anything else unreadable is refused. */
export async function readRecord(actionsDir: string, actionId: string): Promise<Read | OpRead | Outcome> {
  const name = `${actionId}.json`;
  const handle = await open(join(actionsDir, name), OPEN_FLAGS).catch((error: unknown) => codeOf(error));
  if (typeof handle === "string") return handle === "ENOENT" ? { outcome: "gone", reason: `no action record ${actionId}` } : refused("record-unreadable", `${name} could not be opened (${handle})`);
  try {
    if (!(await handle.stat()).isFile()) return refused("record-unreadable", `${name} is not a regular file`);
    const buffer = Buffer.alloc(MAX_ACTION_RECORD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_ACTION_RECORD_BYTES) return refused("record-unreadable", `${name} is over ${MAX_ACTION_RECORD_BYTES} bytes`);
    return parseRecord(buffer.subarray(0, bytesRead), name);
  } finally {
    await handle.close();
  }
}

/** An action record reads exactly as it did before ops existed: it is tried first, and an op is read only from a record with no action. */
function parseRecord(bytes: Uint8Array, name: string): Read | OpRead | Outcome {
  const json = jsonOf(bytes);
  const confirmEvent = `action:${createHash("sha256").update(bytes).digest("hex")}`;
  const action = ActionRecord.safeParse(json);
  if (action.success) return { action: action.data.action, confirmEvent };
  const op = OpRecord.safeParse(json);
  if (op.success) return { op: op.data.op, confirmEvent };
  if (typeof json === "object" && json !== null && Object.hasOwn(json, "op")) return refused("record", `${name} names no owner op the factory reads`);
  return refused("record", `${name} does not read as a resolve-gate, owner-release or plan-approval action record`);
}

function jsonOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
}

const codeOf = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EIO");
