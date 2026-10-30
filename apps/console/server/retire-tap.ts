/**
 * `taps.prepare` and `taps.act`: the owner's Retire tap on an agent page (TP-3620 R2). A retire is no inbox item, so the pair is
 * keyed by a typed target instead of an item id, over the same kernel (`owner-tap.ts`), actions directory and factory route as
 * the inbox's retire-agent op. `prepare` (read) finds the agent holding the name on the console's roster, offers nothing for a
 * seat, an adopted session or a live one, and reads the rest back from the factory's `owner-op.preview` (`retireReadBackOf`).
 * `act` (owner-write) reads both again, refuses a confirm whose read-back changed, writes the op record once and posts its id.
 * The factory re-checks everything and answers `retired`, `already`, `moved {currentAgentId}`, `gone` or `refused`.
 *
 * Never `--force`: agent-chat's roster carries no exit time, so the grace a forced retire must wait out cannot be checked, and the
 * factory refuses one too. The record and outcome files are the audit; a retire is an operation, so the decision log gets nothing.
 */
import { z } from "zod";
import { ownerOpSchema } from "@titan-design/owner-queue";
import { EXIT } from "@titan-design/registry";
import type { AgentRosterEntry } from "@titan-design/chat-protocol/agents";
import { failure } from "./active-work.js";
import { readRoster, type AgentsSource } from "./agents.js";
import { ACTIONS_OFF, type InboxActionOptions } from "./inbox-actions.js";
import { movedMessage, opMessageOf, retireReadBackOf, type AgentOpReadBack, type RetireOp } from "./inbox-op.js";
import type { ActionOutcome, Unreachable } from "./owner-action.js";
import { ownerWriteCommand, readCommand } from "./owner-guard.js";
import type { ShepherdSource } from "./shepherd.js";
import { CONFIRM, CONFIRM_TTL_MS, digestOf, preparedStore, recordOnce, refuse, settleOutcome, writeRecord, type Prepared, type PreparedStore } from "./owner-tap.js";

const CHANGED = "the agent changed since it was read; read it again before confirming";
const STALE = "the confirmation is unknown or over five minutes old; read the agent again";
const PROPOSAL = { proposedBy: "you", proposal: "Retire from the agent page" } as const;

/** agent-chat's `PEER_NAME_PATTERN`, so no name read here can be taken for a flag. */
const target = z.strictObject({ kind: z.literal("retire-agent"), name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) });
type Target = z.infer<typeof target>;

interface RetireTapSources {
  agents: AgentsSource | undefined;
  shepherd: ShepherdSource;
}

type Outcome = ActionOutcome | Unreachable;

export type TapPrepareResult =
  | { status: "ready"; target: Target; readBack: AgentOpReadBack; readAt: string; confirm: string; expiresAt: string }
  | { status: "no-action"; target: Target; reason: string };

type TapActResult = { actionId: string; outcome: Outcome; message: string };

/** The plain retire the console may ask the factory to preview for this roster row, or why it offers no Retire. */
function retireOpOf(entry: AgentRosterEntry | undefined, name: string): RetireOp | string {
  if (entry === undefined) return `no unretired agent holds the name ${name}, so there is nothing to retire`;
  if (entry.seat !== null && entry.seat === entry.name) return "a seat is retired by its owner session";
  if (entry.origin !== "spawned" || entry.agentId === null) return `${name} was not spawned by agent-chat, so the console does not retire it`;
  if (entry.state !== "exited") return `${name} is ${entry.state}; retire a working agent at the terminal`;
  return { kind: "retire-agent", name, agentId: entry.agentId, force: false };
}

interface Read {
  readAt: string;
  readBack: AgentOpReadBack | string;
  op?: RetireOp;
}

async function readTarget({ agents, shepherd }: RetireTapSources, { name }: Target, now: () => number): Promise<Read> {
  const readAt = new Date(now()).toISOString();
  if (agents === undefined) return { readAt, readBack: "the console reads no agent-chat roster" };
  const entry = (await readRoster(agents)).agents.find((agent) => agent.name === name && agent.state !== "retired");
  const op = retireOpOf(entry, name);
  if (typeof op === "string") return { readAt, readBack: op };
  return { readAt, op, readBack: await retireReadBackOf(shepherd, op, PROPOSAL) };
}

/** The read-back holds the agent id and state, so a name taken by a new agent between the two taps refuses the confirm. */
const tapDigest = (key: string, readBack: AgentOpReadBack, readAt: string): string => digestOf([key, readBack, readAt]);

const keyOf = ({ kind, name }: Target): string => `${kind}:${name}`;

interface TapContext {
  sources: RetireTapSources;
  options: InboxActionOptions;
  now: () => number;
}

async function prepare(ctx: TapContext, store: PreparedStore, tapTarget: Target): Promise<TapPrepareResult> {
  const { readAt, readBack } = await readTarget(ctx.sources, tapTarget, ctx.now);
  if (typeof readBack === "string") return { status: "no-action", target: tapTarget, reason: readBack };
  const confirm = tapDigest(keyOf(tapTarget), readBack, readAt);
  const expiresAt = ctx.now() + CONFIRM_TTL_MS;
  store.remember(confirm, { key: keyOf(tapTarget), readAt, expiresAt });
  return { status: "ready", target: tapTarget, readBack, readAt, confirm, expiresAt: new Date(expiresAt).toISOString() };
}

/** A fresh tap reads the agent again at the prepare's `readAt`; only the read-back the owner was shown is written. */
async function writeTapRecord(ctx: TapContext & { issuedAt: number }, file: string, tapTarget: Target, confirm: string, prepared: Prepared): Promise<void> {
  const { readBack, op } = await readTarget(ctx.sources, tapTarget, ctx.now);
  if (typeof readBack === "string" || op === undefined || tapDigest(prepared.key, readBack, prepared.readAt) !== confirm) return refuse(CHANGED);
  const record = { target: tapTarget, op, readBack, confirm, readAt: prepared.readAt, session: { issuedAt: ctx.issuedAt }, peer: "lan-remote", at: new Date(ctx.now()).toISOString() };
  await writeRecord(ctx.options.actionsDir, file, record);
}

/** The factory reads only `op`; a record naming an `action` would be read as a gate, so one is refused. */
const tapRecord = z.looseObject({ op: ownerOpSchema, action: z.never().optional() });

function messageOf(outcome: Outcome, name: string): string {
  switch (outcome.status) {
    case "retired":
      return opMessageOf(outcome);
    case "already":
      return "Already retired by this confirmation";
    case "moved":
      return movedMessage(outcome);
    case "gone":
      return `Nothing to retire: ${outcome.reason}`;
    case "refused":
      return `Not retired (${outcome.reason})${outcome.detail === undefined ? "" : `: ${outcome.detail}`}`;
    case "off":
      return `The factory's console-action route is not mounted; run agent-chat agent retire ${name} on the terminal`;
    case "unreachable":
      return `The factory could not be reached, try again: ${outcome.detail}`;
    default:
      return `The factory answered ${outcome.status} to a retire`;
  }
}

async function act(ctx: TapContext & { issuedAt: number }, store: PreparedStore, { target: tapTarget, confirm }: { target: Target; confirm: string }): Promise<TapActResult> {
  const write = (file: string, prepared: Prepared) => writeTapRecord(ctx, file, tapTarget, confirm, prepared);
  const { file } = await recordOnce({ store, actionsDir: ctx.options.actionsDir, confirm, key: keyOf(tapTarget), stale: STALE, schema: tapRecord, write });
  const outcome = await ctx.options.client.post(confirm);
  await settleOutcome(file, outcome, new Date(ctx.now()).toISOString());
  return { actionId: confirm, outcome, message: messageOf(outcome, tapTarget.name) };
}

const assertOn = (options: InboxActionOptions): void => {
  if (!options.enabled) throw failure(ACTIONS_OFF, EXIT.UNAVAILABLE);
};

/** `afterAct` runs once an act settles, so the roster and inbox reads drop what the retire changed. */
export function retireTapCommands(sources: RetireTapSources, options: InboxActionOptions, afterAct: () => void = () => undefined) {
  const now = options.now ?? Date.now;
  const store = preparedStore(now);
  return {
    "taps.prepare": readCommand({
      name: "taps.prepare",
      description: "Re-read one agent and return the read-back of what a Retire tap does, with a confirm digest valid five minutes",
      args: z.strictObject({ target }),
      result: z.custom<TapPrepareResult>(),
      run: (args) => {
        assertOn(options);
        return prepare({ sources, options, now }, store, args.target);
      },
    }),
    "taps.act": ownerWriteCommand({
      name: "taps.act",
      description: "Retire an agent as a prepared read-back said: write the retire-agent op record once and post it to the factory",
      args: z.strictObject({ target, confirm: z.string().regex(CONFIRM) }),
      result: z.custom<TapActResult>(),
      ownerWrite: true,
      run: (args, ctx) => {
        assertOn(options);
        return act({ sources, options, now, issuedAt: ctx.ownerPresence.issuedAt }, store, args).finally(afterAct);
      },
    }),
  };
}
