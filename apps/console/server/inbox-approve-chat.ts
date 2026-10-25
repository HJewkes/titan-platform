/**
 * An `approve-chat` tap: an agent's permission prompt or endorsement, decided from the inbox. The inbox item is only a pointer.
 * The factory folds permission prompts, endorsements and `needs-grant` / `ready-to-merge` notices into one `approve` kind and
 * drops the row's meta, so the read-back comes from the broker's own `/api/queue` row, the system of record. Only an
 * `approval_request` or an `endorse_request` row offers a tap; any other row, or none, answers with the terminal reason.
 *
 * The verdict goes to the broker through `brokerVerdicter`, which the broker arbitrates. An endorse posts the read-back's
 * stored text and recipient from the action record, byte for byte, never the item's summary or context.
 */
import { z } from "zod";
import type { BrokerEvent } from "@titan-design/chat-protocol/agents";
import type { AgentsSource } from "./agents.js";
import type { BrokerVerdicter, VerdictOutcome } from "./broker-verdict.js";
import type { InboxItem } from "./inbox-view.js";
import { readSettled, refuse } from "./owner-tap.js";

export type ApproveChatAction = Extract<InboxItem["action"], { kind: "approve-chat" }>;

export const VERDICTS = ["allow", "deny", "endorse"] as const;
type Verdict = (typeof VERDICTS)[number];

export const APPROVE_AT_SESSION = "an agent's approval or permission prompt is answered at its own session";

const permissionReadBack = z.object({
  msgId: z.string(),
  kind: z.literal("permission"),
  tool: z.string(),
  inputPreview: z.string(),
  description: z.string(),
  asker: z.string().optional(),
  choices: z.tuple([z.literal("allow"), z.literal("deny")]),
  effect: z.string(),
});

const endorseReadBack = z.object({ msgId: z.string(), kind: z.literal("endorse"), text: z.string(), to: z.string(), asker: z.string().optional(), effect: z.string() });

const approveChatReadBack = z.discriminatedUnion("kind", [permissionReadBack, endorseReadBack]);

export type ApproveChatReadBack = z.infer<typeof approveChatReadBack>;

const askerOf = (row: BrokerEvent): { asker?: string } => (row.from === "" ? {} : { asker: row.from });

function readBackOfRow(row: BrokerEvent): ApproveChatReadBack | string {
  const who = row.from || "the agent";
  if (row.kind === "approval_request") {
    const tool = row.meta["tool_name"] ?? "";
    const effect = `Answer ${who}'s permission prompt for ${tool || "a tool"}; the broker records the verdict as yours, from the console`;
    return { msgId: row.msgId, kind: "permission", tool, inputPreview: row.meta["input_preview"] ?? "", description: row.text, ...askerOf(row), choices: ["allow", "deny"], effect };
  }
  const to = row.meta["recipient"];
  if (row.kind !== "endorse_request" || to === undefined) return APPROVE_AT_SESSION;
  return { msgId: row.msgId, kind: "endorse", text: row.text, to, ...askerOf(row), effect: `Deliver this exact text to ${to} with your authority, as ${who} asked` };
}

/** Re-read per prepare and per act, so a row closed or changed in between refuses the stale confirm. */
export async function approveChatReadBackOf(agents: AgentsSource | undefined, action: ApproveChatAction): Promise<ApproveChatReadBack | string> {
  if (agents === undefined) return APPROVE_AT_SESSION;
  const row = (await agents.broker.queue()).find((each) => each.msgId === action.msgId);
  return row === undefined ? APPROVE_AT_SESSION : readBackOfRow(row);
}

const offeredVerdicts = (readBack: ApproveChatReadBack): readonly Verdict[] => (readBack.kind === "permission" ? readBack.choices : ["endorse"]);

/** A permission prompt takes allow or deny and an endorsement takes endorse; nothing else takes a verdict. */
export function verdictFor(readBack: ApproveChatReadBack | undefined, verdict: Verdict | undefined): Verdict | undefined {
  if (readBack === undefined) return verdict === undefined ? undefined : refuse("only an agent's permission prompt or endorsement takes a verdict");
  if (verdict === undefined) return refuse(`a ${readBack.kind} tap needs a verdict: ${offeredVerdicts(readBack).join(" or ")}`);
  return offeredVerdicts(readBack).includes(verdict) ? verdict : refuse(`a ${readBack.kind} tap takes ${offeredVerdicts(readBack).join(" or ")}, not ${verdict}`);
}

const verdictRecord = z.looseObject({ readBack: approveChatReadBack, verdict: z.enum(VERDICTS) });

type AlreadyOutcome = { status: "already" };

/** What a replay answers from the outcome already settled; undefined when nothing is settled yet, so the tap may post. */
function replayOf(settled: Awaited<ReturnType<typeof readSettled>>): VerdictOutcome | AlreadyOutcome | undefined {
  if (settled === undefined) return undefined;
  if (settled.status === "answered") return { status: "already" };
  const reason = typeof settled["reason"] === "string" ? settled["reason"] : "decided by an earlier tap";
  return settled.status === "closed" ? { status: "closed", reason } : { status: "refused", reason };
}

/**
 * The broker refuses a second verdict, but a replay must not reach it at all, so a settled outcome answers the replay. The
 * verdict and the endorse bytes come from the record written at the first tap.
 */
export async function dispatchVerdict(verdicter: BrokerVerdicter | undefined, file: string, record: unknown): Promise<VerdictOutcome | AlreadyOutcome> {
  if (verdicter === undefined) return { status: "unreachable", detail: "the broker verdicter is not wired" };
  const parsed = verdictRecord.safeParse(record);
  if (!parsed.success) return { status: "unreachable", detail: "the action record carries no verdict read-back" };
  const replay = replayOf(await readSettled(file));
  if (replay !== undefined) return replay;
  const { readBack, verdict } = parsed.data;
  if (readBack.kind === "endorse") return verdicter.endorse(readBack.msgId, readBack.text, readBack.to);
  return verdict === "endorse" ? { status: "refused", reason: "a permission prompt takes allow or deny" } : verdicter.permission(readBack.msgId, verdict);
}

const terminalCommandOf = (readBack: ApproveChatReadBack | undefined, msgId: string): string =>
  readBack?.kind === "endorse" ? `agent-chat endorse ${msgId}` : `agent-chat approve ${msgId} allow|deny`;

const ANSWERED: Record<Verdict, string> = { allow: "Allowed", deny: "Denied", endorse: "Endorsed and delivered" };

/** A refusal names the terminal command, since a broker without the verdict routes (a 404) refuses every tap. */
export function verdictMessageOf(outcome: { status: string; reason?: string; detail?: string }, record: unknown, msgId: string): string {
  const parsed = verdictRecord.safeParse(record);
  switch (outcome.status) {
    case "answered":
      return parsed.success ? ANSWERED[parsed.data.verdict] : "Verdict sent";
    case "already":
      return "Already done by this confirmation";
    case "closed":
      return `Not sent; the prompt is closed, likely answered at its session: ${outcome.reason ?? "closed"}`;
    case "refused":
      return `Refused (${outcome.reason ?? "no reason given"}); answer it at the terminal: ${terminalCommandOf(parsed.data?.readBack, msgId)}`;
    default:
      return `The agent-chat broker could not be reached, try again: ${outcome.detail ?? outcome.status}`;
  }
}
