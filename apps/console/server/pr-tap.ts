/**
 * `prTaps.prepare` and `prTaps.act`: the owner's Close and Merge taps on a PR page, so a close-pr or merge-at-head no longer
 * needs an agent's deposit to reach the console. Like the agent page's Retire (`retire-tap.ts`) the pair is keyed by a typed
 * target, over the same kernel (`owner-tap.ts`), actions directory and factory route as the inbox's owner-op taps.
 * `prepare` (read) reads the PR back from the factory's `owner-op.preview` (`prReadOf`), and offers nothing on an authority
 * deny, a PR that is not open, or a head that moved past the one the page showed. `act` (owner-write) reads it again,
 * refuses a confirm whose read-back changed, writes the op record once pinned to the previewed head, and posts its id.
 * The factory re-checks the head and answers `accepted`, `pr-closed`, `already`, `moved`, `gone` or `refused`.
 */
import { z } from "zod";
import { ownerOpSchema } from "@titan-design/owner-queue";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { ACTIONS_OFF, type InboxActionOptions } from "./inbox-actions.js";
import { movedMessage, opMessageOf, prReadOf, type PrOp, type PrOpReadBack } from "./inbox-op.js";
import type { ActionOutcome, Unreachable } from "./owner-action.js";
import { ownerWriteCommand, readCommand } from "./owner-guard.js";
import { refusalMessageOf } from "./refusal-message.js";
import type { ShepherdSource } from "./shepherd.js";
import { CONFIRM, CONFIRM_TTL_MS, digestOf, preparedStore, recordOnce, refuse, settleOutcome, writeRecord, type Prepared, type PreparedStore } from "./owner-tap.js";

const CHANGED = "the PR changed since it was read; read it again before confirming";
const STALE = "the confirmation is unknown or over five minutes old; read the PR again";
const PROPOSAL = { "close-pr": "Close from the PR page", "merge-at-head": "Merge from the PR page" } as const;

const target = z.strictObject({
  kind: z.enum(["close-pr", "merge-at-head"]),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  pr: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
});
type Target = z.infer<typeof target>;

type Outcome = ActionOutcome | Unreachable;

export type PrTapPrepareResult =
  | { status: "ready"; target: Target; readBack: PrOpReadBack; readAt: string; confirm: string; expiresAt: string }
  | { status: "no-action"; target: Target; reason: string };

type PrTapActResult = { actionId: string; outcome: Outcome; message: string };

const short = (sha: string): string => sha.slice(0, 7);

/** The op the factory previews and the record posts; its head is the one the page showed, and a read-back at any other refuses. */
const opOf = ({ kind, repo, pr, headSha }: Target): PrOp => ({ kind, repo, pr, headSha });

interface Read {
  readAt: string;
  readBack: PrOpReadBack | string;
}

async function readTarget(shepherd: ShepherdSource, tapTarget: Target, now: () => number): Promise<Read> {
  const readAt = new Date(now()).toISOString();
  const readBack = await prReadOf(shepherd, opOf(tapTarget), { proposedBy: "you", proposal: PROPOSAL[tapTarget.kind] });
  if (typeof readBack === "string" || readBack.headSha === tapTarget.headSha) return { readAt, readBack };
  return { readAt, readBack: `${tapTarget.repo}#${tapTarget.pr} moved to ${short(readBack.headSha)} since the page read ${short(tapTarget.headSha)}; read it again` };
}

const tapDigest = (key: string, readBack: PrOpReadBack, readAt: string): string => digestOf([key, readBack, readAt]);

const keyOf = ({ kind, repo, pr, headSha }: Target): string => `${kind}:${repo}#${pr}@${headSha}`;

interface TapContext {
  shepherd: ShepherdSource;
  options: InboxActionOptions;
  now: () => number;
}

async function prepare(ctx: TapContext, store: PreparedStore, tapTarget: Target): Promise<PrTapPrepareResult> {
  const { readAt, readBack } = await readTarget(ctx.shepherd, tapTarget, ctx.now);
  if (typeof readBack === "string") return { status: "no-action", target: tapTarget, reason: readBack };
  const confirm = tapDigest(keyOf(tapTarget), readBack, readAt);
  const expiresAt = ctx.now() + CONFIRM_TTL_MS;
  store.remember(confirm, { key: keyOf(tapTarget), readAt, expiresAt });
  return { status: "ready", target: tapTarget, readBack, readAt, confirm, expiresAt: new Date(expiresAt).toISOString() };
}

/** A fresh tap reads the PR again at the prepare's `readAt`; only the read-back the owner was shown is written, at its head. */
async function writeTapRecord(ctx: TapContext & { issuedAt: number }, file: string, tapTarget: Target, confirm: string, prepared: Prepared): Promise<void> {
  const { readBack } = await readTarget(ctx.shepherd, tapTarget, ctx.now);
  if (typeof readBack === "string" || tapDigest(prepared.key, readBack, prepared.readAt) !== confirm) return refuse(CHANGED);
  const op = { ...opOf(tapTarget), headSha: readBack.headSha };
  const record = { target: tapTarget, op, readBack, confirm, readAt: prepared.readAt, session: { issuedAt: ctx.issuedAt }, peer: "lan-remote", at: new Date(ctx.now()).toISOString() };
  await writeRecord(ctx.options.actionsDir, file, record);
}

/** The factory reads only `op`; a record naming an `action` would be read as a gate, so one is refused. */
const tapRecord = z.looseObject({ op: ownerOpSchema, action: z.never().optional() });

function messageOf(outcome: Outcome): string {
  switch (outcome.status) {
    case "accepted":
    case "pr-closed":
      return opMessageOf(outcome);
    case "already":
      return "Already done by this confirmation";
    case "moved":
      return movedMessage(outcome);
    case "gone":
      return `Nothing to act on: ${outcome.reason}`;
    case "refused":
      return refusalMessageOf(outcome.reason, outcome.detail);
    case "off":
      return "The factory's console-action route is not mounted; act on the PR at the terminal";
    case "unreachable":
      return `The factory could not be reached, try again: ${outcome.detail}`;
    default:
      return `The factory answered ${outcome.status} to a PR tap`;
  }
}

async function act(ctx: TapContext & { issuedAt: number }, store: PreparedStore, { target: tapTarget, confirm }: { target: Target; confirm: string }): Promise<PrTapActResult> {
  const write = (file: string, prepared: Prepared) => writeTapRecord(ctx, file, tapTarget, confirm, prepared);
  const { file } = await recordOnce({ store, actionsDir: ctx.options.actionsDir, confirm, key: keyOf(tapTarget), stale: STALE, schema: tapRecord, write });
  const outcome = await ctx.options.client.post(confirm);
  await settleOutcome(file, outcome, new Date(ctx.now()).toISOString());
  return { actionId: confirm, outcome, message: messageOf(outcome) };
}

const assertOn = (options: InboxActionOptions): void => {
  if (!options.enabled) throw failure(ACTIONS_OFF, EXIT.UNAVAILABLE);
};

/** `afterAct` runs once an act settles, so the inbox reads drop what the close or merge changed. */
export function prTapCommands(shepherd: ShepherdSource, options: InboxActionOptions, afterAct: () => void = () => undefined) {
  const now = options.now ?? Date.now;
  const store = preparedStore(now);
  return {
    "prTaps.prepare": readCommand({
      name: "prTaps.prepare",
      description: "Re-read one PR and return the read-back of what a Close or Merge tap does at the head the page showed, with a confirm digest valid five minutes",
      args: z.strictObject({ target }),
      result: z.custom<PrTapPrepareResult>(),
      run: (args) => {
        assertOn(options);
        return prepare({ shepherd, options, now }, store, args.target);
      },
    }),
    "prTaps.act": ownerWriteCommand({
      name: "prTaps.act",
      description: "Close or merge a PR as a prepared read-back said: write the op record pinned to that head once and post it to the factory",
      args: z.strictObject({ target, confirm: z.string().regex(CONFIRM) }),
      result: z.custom<PrTapActResult>(),
      ownerWrite: true,
      run: (args, ctx) => {
        assertOn(options);
        return act({ shepherd, options, now, issuedAt: ctx.ownerPresence.issuedAt }, store, args).finally(afterAct);
      },
    }),
  };
}
