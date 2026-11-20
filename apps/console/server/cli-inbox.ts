/**
 * `titan-console inbox answer <id> --as <seat>`: the asking seat reads the owner's answer to its own deposit.
 * `titan-console inbox withdraw|restore|withdraw-matching`: a seat takes back its own deposits. Like
 * `rounds withdraw`, these are local verbs and never `/rpc`, so nothing that reaches the daemon can take
 * an item away from the owner. Each writes the spool directly; owner-queue's withdraw module does the
 * checks and keeps the audit log. `--as` names the deposit's asker and `--actor` the seat running the
 * verb, so the log can tell a seat closing a retired automation's items from the automation itself.
 * `titan-console inbox step <id> <n> --done|--skipped`: a sitting's asker records one step's outcome; the last one closes it.
 */
import { EXIT } from "@titan-design/registry";
import { readAnswer, readSpool } from "@titan-design/owner-queue/spool";
import type { OwnerAnswer, StepOutcome } from "@titan-design/owner-queue";
import {
  restoreDeposit,
  withdrawDeposit,
  withdrawMatching,
  WithdrawRefusedError,
  type RestoreResult,
  type WithdrawResult,
} from "@titan-design/owner-queue/withdraw";
import { recordStep, StepRefusedError, type StepResult } from "@titan-design/owner-queue/sitting";
import { failure } from "./active-work.js";
import { runVerb } from "./cli-rounds.js";
import type { ConsoleConfig } from "./config.js";

/** `actor` is null when `--actor` is missing: the verb parses, then refuses with exit 65. */
type InboxWithdrawArgs = { actor: string | null } & (
  | { verb: "withdraw"; id: string; reason: string; as: string; json: boolean }
  | { verb: "restore"; id: string; as: string; json: boolean }
  | { verb: "answer"; id: string; as: string; json: boolean }
  | { verb: "withdraw-matching"; as: string; keys: string[]; reason: string; dryRun: boolean; json: boolean }
  | { verb: "step"; id: string; step: number; outcome: StepOutcome; as: string; json: boolean }
);

interface Split {
  values: Map<string, string[]>;
  flags: Set<string>;
  positional: string[];
}

const VALUE_FLAGS = new Set(["--reason", "--as", "--actor", "--key"]);
const SWITCHES = new Set(["--json", "--dry-run", "--done", "--skipped"]);
const OUTCOME_SWITCHES = ["--done", "--skipped"] as const;
const STEP_NUMBER = /^[1-9]\d{0,1}$/;

/** Null when a value flag has no value or an unknown `--` flag appears. */
function split(rest: readonly string[]): Split | null {
  const out: Split = { values: new Map(), flags: new Set(), positional: [] };
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at]!;
    if (SWITCHES.has(arg)) out.flags.add(arg);
    else if (VALUE_FLAGS.has(arg)) {
      const value = rest[at + 1];
      if (value === undefined || value.startsWith("--")) return null;
      out.values.set(arg, [...(out.values.get(arg) ?? []), value]);
      at += 1;
    } else if (arg.startsWith("--")) return null;
    else out.positional.push(arg);
  }
  return out;
}

/** The one value of a flag given exactly once; undefined when it is missing or repeated. */
const single = (parts: Split, flag: string): string | undefined => {
  const values = parts.values.get(flag);
  return values?.length === 1 ? values[0] : undefined;
};

/** Null when `--actor` is missing, undefined when it is repeated. */
const actorOf = (parts: Split): string | null | undefined => (parts.values.has("--actor") ? single(parts, "--actor") : null);

function itemVerb(verb: "withdraw" | "restore" | "answer", parts: Split): InboxWithdrawArgs | null {
  const [id] = parts.positional;
  const as = single(parts, "--as");
  const actor = actorOf(parts);
  const reason = single(parts, "--reason");
  if (id === undefined || parts.positional.length !== 1 || as === undefined || actor === undefined || parts.values.has("--key") || parts.flags.has("--dry-run") || outcomeOf(parts) !== null) return null;
  const json = parts.flags.has("--json");
  if (verb === "answer") return parts.values.has("--reason") || parts.values.has("--actor") ? null : { verb, id, as, actor, json };
  if (verb === "restore") return parts.values.has("--reason") ? null : { verb, id, as, actor, json };
  return reason === undefined ? null : { verb, id, reason, as, actor, json };
}

/** The one outcome switch given: null when there is none, undefined when both are. */
function outcomeOf(parts: Split): StepOutcome | null | undefined {
  const given = OUTCOME_SWITCHES.filter((flag) => parts.flags.has(flag));
  if (given.length > 1) return undefined;
  return given[0] === undefined ? null : given[0] === "--done" ? "done" : "skipped";
}

function stepVerb(parts: Split): InboxWithdrawArgs | null {
  const [id, step] = parts.positional;
  const as = single(parts, "--as");
  const actor = actorOf(parts);
  const outcome = outcomeOf(parts);
  if (id === undefined || step === undefined || !STEP_NUMBER.test(step) || parts.positional.length !== 2) return null;
  if (as === undefined || actor === undefined || outcome == null || parts.values.has("--key") || parts.values.has("--reason") || parts.flags.has("--dry-run")) return null;
  return { verb: "step", id, step: Number(step), outcome, as, actor, json: parts.flags.has("--json") };
}

function matchingVerb(parts: Split): InboxWithdrawArgs | null {
  const as = single(parts, "--as");
  const actor = actorOf(parts);
  const reason = single(parts, "--reason");
  const keys = parts.values.get("--key") ?? [];
  if (as === undefined || actor === undefined || reason === undefined || keys.length === 0 || parts.positional.length > 0 || outcomeOf(parts) !== null) return null;
  return { verb: "withdraw-matching", as, actor, keys, reason, dryRun: parts.flags.has("--dry-run"), json: parts.flags.has("--json") };
}

/** `inbox withdraw|restore|withdraw-matching ...`, flags in any order after the verb; null for anything else. */
export function inboxWithdrawArgs(argv: readonly string[]): InboxWithdrawArgs | null {
  const [noun, verb, ...rest] = argv;
  if (noun !== "inbox") return null;
  const parts = split(rest);
  if (parts === null) return null;
  if (verb === "withdraw" || verb === "restore" || verb === "answer") return itemVerb(verb, parts);
  if (verb === "step") return stepVerb(parts);
  return verb === "withdraw-matching" ? matchingVerb(parts) : null;
}

/** An unknown id exits 66 and any other refusal 65, each with its one-line reason. */
function asExit(error: unknown): never {
  if (!(error instanceof WithdrawRefusedError || error instanceof StepRefusedError)) throw error;
  throw failure(`${error.kind === "unknown" ? "not found" : "refused"}: ${error.message}`, error.kind === "unknown" ? EXIT.NOINPUT : EXIT.DATAERR);
}

interface MatchReport {
  outcome: "would-withdraw" | "withdrawn";
  items: { id: string; summary: string }[];
}
type AnswerReport = OwnerAnswer & { id: string };
type Report = WithdrawResult | RestoreResult | MatchReport | AnswerReport | StepResult;

const DEPOSIT_PREFIX = "deposit:";

/** The deposit `ref` names, by full id or a hex prefix of at least 8 digits, with or without `deposit:`. */
async function findDeposit(dir: string, ref: string): Promise<{ id: string; asker?: string | undefined }> {
  const hex = ref.startsWith(DEPOSIT_PREFIX) ? ref.slice(DEPOSIT_PREFIX.length) : ref;
  const unknown = new WithdrawRefusedError(`unknown id ${ref}; full form is deposit:<32 hex>`, "unknown");
  if (!/^[0-9a-f]{8,32}$/i.test(hex)) throw unknown;
  const prefix = `${DEPOSIT_PREFIX}${hex.toLowerCase()}`;
  const matches = (await readSpool(dir)).items.filter((item) => item.id.startsWith(prefix));
  const [only] = matches;
  if (only === undefined) throw unknown;
  if (matches.length > 1) throw new WithdrawRefusedError(`ambiguous id ${ref} matches ${matches.map((item) => item.id).sort().join(", ")}`, "refused");
  return only;
}

async function answerOf(dir: string, ref: string, as: string): Promise<AnswerReport> {
  const deposit = await findDeposit(dir, ref);
  if (deposit.asker !== as) throw new WithdrawRefusedError(`${deposit.id} was filed by ${deposit.asker ?? "no asker"}, not ${as}`, "refused");
  const answer = await readAnswer(dir, deposit.id);
  if (answer === undefined) throw failure(`not answered yet: ${deposit.id}`, EXIT.TEMPFAIL);
  return { id: deposit.id, ...answer };
}

async function run(dir: string, args: InboxWithdrawArgs): Promise<Report> {
  if (args.verb === "answer") return answerOf(dir, args.id, args.as);
  const { actor } = args;
  if (actor === null) throw failure("refused: --actor <seat> is required: name the seat running this", EXIT.DATAERR);
  if (args.verb === "withdraw") return withdrawDeposit(dir, args.id, { reason: args.reason, as: args.as, actor });
  if (args.verb === "restore") return restoreDeposit(dir, args.id, { as: args.as, actor });
  if (args.verb === "step") return recordStep(dir, args.id, args.step, { outcome: args.outcome, as: args.as, actor });
  const items = await withdrawMatching(dir, { asker: args.as, actor, keys: args.keys, reason: args.reason, dryRun: args.dryRun });
  return { outcome: args.dryRun ? "would-withdraw" : "withdrawn", items: items.map(({ id, summary }) => ({ id, summary })) };
}

function text(report: Report): string {
  if ("by" in report) return [report.optionId ?? report.optionIds?.join(", ") ?? report.text ?? "", `by ${report.by.class}:${report.by.id} (${report.by.channel})`, `at ${report.at}`].join("\n");
  if ("step" in report) return [report.id, `step ${report.step}: ${report.outcome} (${report.result})`, ...(report.closed ? ["sitting closed"] : [])].join("\n");
  if ("items" in report) return [...report.items.map((item) => `${item.id}  ${item.summary}`), `${report.outcome}: ${report.items.length}`].join("\n");
  return `${report.id}\n${report.outcome}`;
}

export async function inboxWithdrawCli(config: ConsoleConfig, args: InboxWithdrawArgs): Promise<void> {
  await runVerb(
    () => run(config.inboxDir, args).catch(asExit),
    (result) => (args.json ? JSON.stringify(result) : text(result)),
  );
}
