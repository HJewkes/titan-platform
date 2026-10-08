import type { ReviewTarget } from "@titan-design/review-panel";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { accountAlertText, accountHoldReason, believedReset, parseLimitReset, type ReviewAccounts } from "./account-limit.js";
import type { AccountLimitStore } from "./account-store.js";
import type { ShepherdDeps, Verdict } from "./phases.js";

const ACCOUNT_HOLD_STEP = "sh-account-hold";
const ACCOUNT_WAIT_STEP = "sh-account-wait";
export const ACCOUNT_STEPS: readonly StepDeclaration[] = [
  { id: ACCOUNT_HOLD_STEP, kind: "dispatch" },
  { id: ACCOUNT_WAIT_STEP, kind: "dispatch" },
];
const DEFAULT_POLL_MS = 30_000;
/** How long one wait holds the run before it reads the head and reviews again; a hold that still applies waits again. */
export const ACCOUNT_WAIT_LIMIT_MS = 60 * 60_000;

/** The accounts the hold and the wait read: only the dirs, so a review with no accounts wired holds its one default account. */
export type AccountsView = Pick<ReviewAccounts, "dirs" | "alert">;

/** The account a review would bill, and the reviewer's limit notice when one ended its turn. */
interface Exhausted {
  account: string;
  notice?: string;
  /** The reset the client recorded on the notice, epoch ms; absent means it is read from the notice's text. */
  resetsAt?: number;
}

interface HoldInput extends ReviewTarget, Exhausted {
  runId: string;
}

/** `own` is false when another hold already stood, so the wait never mistakes that hold's release for one of its own. */
const HoldResult = z.looseObject({ held: z.boolean(), own: z.boolean(), reason: z.string() });
type Held = z.infer<typeof HoldResult>;

const RESUMES = ["headroom", "released", "head-moved", "expired"] as const;
const WaitResult = z.looseObject({ resumed: z.enum(RESUMES) });
type Waited = z.infer<typeof WaitResult>;

interface WaitInput extends HoldInput {
  own: boolean;
}

/**
 * The account is out of usage: record it, tell the seat once, and either move the review to an account with headroom or hold
 * the run until one has it. Either way the review ends `account-exhausted`, which reviews the PR's current head again.
 */
export async function accountHeld(ctx: WorkflowContext, target: ReviewTarget, exhausted: Exhausted): Promise<Verdict> {
  const input: HoldInput = { ...target, runId: ctx.runId, ...exhausted };
  const held = await step(ctx, `${ACCOUNT_HOLD_STEP}:${target.head}`, input, HoldResult);
  if (held.held) await step(ctx, `${ACCOUNT_WAIT_STEP}:${target.head}`, { ...input, own: held.own } satisfies WaitInput, WaitResult);
  return { kind: "none", cause: "account-exhausted", reason: held.reason };
}

/** Throws when no store is wired, which every caller reads as a store it cannot read. */
function accountLimitsOf(deps: ShepherdDeps): AccountLimitStore {
  if (!deps.accountLimits) throw new Error("no account-limit store is wired");
  return deps.accountLimits.get();
}

/** The first account with headroom, in the configured order. */
const usableAccount = (limits: AccountLimitStore, dirs: readonly string[]): string | undefined => dirs.find((dir) => limits.exhausted(dir) === undefined);

/**
 * The one place the run's own hold follows the accounts: the first account with headroom lifts the hold this store
 * placed, so no hold outlives its exhaustion; null when none has headroom or the limits cannot be read, and the caller holds.
 */
export function accountWithHeadroom(deps: ShepherdDeps, dirs: readonly string[], runId: string): string | null {
  try {
    const limits = accountLimitsOf(deps);
    const account = usableAccount(limits, dirs);
    if (account !== undefined) limits.releaseRun(runId);
    return account ?? null;
  } catch {
    return null;
  }
}

/** The client's recorded reset wins over the one in the notice's text; either is believed only within `believedReset`'s bounds. */
function noteLimit(limits: AccountLimitStore, input: HoldInput, now: number) {
  if (input.notice === undefined) return limits.exhausted(input.account);
  return limits.markExhausted(input.account, believedReset(input.resetsAt ?? parseLimitReset(input.notice, now), now), input.notice);
}

/** Claims the alert first, so two runs on one account send one; an alert that fails gives the claim back. */
async function alertOnce(limits: AccountLimitStore, accounts: AccountsView, input: HoldInput, resetsAt: number | null): Promise<void> {
  if (!accounts.alert || !limits.claimAlert(input.account)) return;
  try {
    await accounts.alert(input.repo, accountAlertText(input.account, resetsAt));
  } catch (error) {
    limits.unclaimAlert(input.account);
    console.warn(`shepherd: the account-exhausted alert for ${input.account} did not go out: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function decideHold(deps: ShepherdDeps, accounts: AccountsView, input: HoldInput): Promise<Held> {
  const limits = accountLimitsOf(deps);
  const resetsAt = noteLimit(limits, input, deps.now())?.resetsAt ?? null;
  await alertOnce(limits, accounts, input, resetsAt);
  const next = accountWithHeadroom(deps, accounts.dirs, input.runId);
  if (next !== null) return { held: false, own: false, reason: `the review account ${input.account} is exhausted; the review moves to ${next}` };
  const reason = accountHoldReason(input.account, resetsAt);
  return { held: true, own: limits.holdRun(input.runId, reason), reason };
}

/** Fails closed: a store that cannot be read still holds the run, with an unknown reset. */
async function holdOrFailClosed(deps: ShepherdDeps, accounts: AccountsView, input: HoldInput): Promise<Held> {
  try {
    return await decideHold(deps, accounts, input);
  } catch {
    const reason = accountHoldReason(input.account, null);
    return { held: true, own: tryHold(deps, input.runId, reason), reason };
  }
}

function tryHold(deps: ShepherdDeps, runId: string, reason: string): boolean {
  try {
    return accountLimitsOf(deps).holdRun(runId, reason);
  } catch {
    return false;
  }
}

/** An owner's release of this hold vouches for the account; with no own hold only headroom lifts the wait. */
function released(deps: ShepherdDeps, input: WaitInput): boolean {
  if (!input.own) return false;
  const limits = accountLimitsOf(deps);
  const registration = deps.store.get().byRun(input.runId);
  if (registration === undefined || limits.holdsRun(input.runId)) return false;
  if (!registration.held) limits.clear(input.account);
  return true;
}

/** Headroom on any account ends the wait, as do a release and a PR that moved on; the next review intent recomputes the hold. */
async function resumeReason(deps: ShepherdDeps, accounts: AccountsView, input: WaitInput): Promise<Waited["resumed"] | undefined> {
  if (released(deps, input)) return "released";
  const limits = accountLimitsOf(deps);
  if (usableAccount(limits, accounts.dirs) !== undefined) return "headroom";
  const pr = await deps.port.getPr(input.repo, input.pr);
  return pr.headSha !== input.head || pr.state !== "open" ? "head-moved" : undefined;
}

/** Any read that fails keeps the hold and is polled again. */
async function awaitHeadroom(deps: ShepherdDeps, accounts: AccountsView, input: WaitInput, signal: AbortSignal): Promise<Waited> {
  const startedAt = deps.now();
  for (;;) {
    signal.throwIfAborted();
    const resumed = await resumeReason(deps, accounts, input).catch(() => undefined);
    if (resumed !== undefined) return { resumed };
    if (deps.now() - startedAt >= ACCOUNT_WAIT_LIMIT_MS) return { resumed: "expired" };
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  }
}

export function accountRoutes(deps: ShepherdDeps, accounts: AccountsView): StepRoute[] {
  return [
    codeRoute(ACCOUNT_HOLD_STEP, deps.now, async (input: HoldInput) => holdOrFailClosed(deps, accounts, input)),
    codeRoute(ACCOUNT_WAIT_STEP, deps.now, async (input: WaitInput, signal) => awaitHeadroom(deps, accounts, input, signal)),
  ];
}
