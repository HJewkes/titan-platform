/**
 * `titan-console inbox withdraw|restore|withdraw-matching`: a seat takes back its own deposits. Like
 * `rounds withdraw`, these are local verbs and never `/rpc`, so nothing that reaches the daemon can take
 * an item away from the owner. Each writes the spool directly; owner-queue's withdraw module does the
 * checks and keeps the audit log. `--as` names the deposit's asker and `--actor` the seat running the
 * verb, so the log can tell a seat closing a retired automation's items from the automation itself.
 */
import { EXIT } from "@titan-design/registry";
import {
  restoreDeposit,
  withdrawDeposit,
  withdrawMatching,
  WithdrawRefusedError,
  type RestoreResult,
  type WithdrawResult,
} from "@titan-design/owner-queue/withdraw";
import { failure } from "./active-work.js";
import { runVerb } from "./cli-rounds.js";
import type { ConsoleConfig } from "./config.js";

/** `actor` is null when `--actor` is missing: the verb parses, then refuses with exit 65. */
type InboxWithdrawArgs = { actor: string | null } & (
  | { verb: "withdraw"; id: string; reason: string; as: string; json: boolean }
  | { verb: "restore"; id: string; as: string; json: boolean }
  | { verb: "withdraw-matching"; as: string; keys: string[]; reason: string; dryRun: boolean; json: boolean }
);

interface Split {
  values: Map<string, string[]>;
  flags: Set<string>;
  positional: string[];
}

const VALUE_FLAGS = new Set(["--reason", "--as", "--actor", "--key"]);
const SWITCHES = new Set(["--json", "--dry-run"]);

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

function itemVerb(verb: "withdraw" | "restore", parts: Split): InboxWithdrawArgs | null {
  const [id] = parts.positional;
  const as = single(parts, "--as");
  const actor = actorOf(parts);
  const reason = single(parts, "--reason");
  if (id === undefined || parts.positional.length !== 1 || as === undefined || actor === undefined || parts.values.has("--key") || parts.flags.has("--dry-run")) return null;
  const json = parts.flags.has("--json");
  if (verb === "restore") return parts.values.has("--reason") ? null : { verb, id, as, actor, json };
  return reason === undefined ? null : { verb, id, reason, as, actor, json };
}

function matchingVerb(parts: Split): InboxWithdrawArgs | null {
  const as = single(parts, "--as");
  const actor = actorOf(parts);
  const reason = single(parts, "--reason");
  const keys = parts.values.get("--key") ?? [];
  if (as === undefined || actor === undefined || reason === undefined || keys.length === 0 || parts.positional.length > 0) return null;
  return { verb: "withdraw-matching", as, actor, keys, reason, dryRun: parts.flags.has("--dry-run"), json: parts.flags.has("--json") };
}

/** `inbox withdraw|restore|withdraw-matching ...`, flags in any order after the verb; null for anything else. */
export function inboxWithdrawArgs(argv: readonly string[]): InboxWithdrawArgs | null {
  const [noun, verb, ...rest] = argv;
  if (noun !== "inbox") return null;
  const parts = split(rest);
  if (parts === null) return null;
  if (verb === "withdraw" || verb === "restore") return itemVerb(verb, parts);
  return verb === "withdraw-matching" ? matchingVerb(parts) : null;
}

/** An unknown id exits 66 and any other refusal 65, each with its one-line reason. */
function asExit(error: unknown): never {
  if (!(error instanceof WithdrawRefusedError)) throw error;
  throw failure(`${error.kind === "unknown" ? "not found" : "refused"}: ${error.message}`, error.kind === "unknown" ? EXIT.NOINPUT : EXIT.DATAERR);
}

interface MatchReport {
  outcome: "would-withdraw" | "withdrawn";
  items: { id: string; summary: string }[];
}
type Report = WithdrawResult | RestoreResult | MatchReport;

async function run(dir: string, args: InboxWithdrawArgs): Promise<Report> {
  const { actor } = args;
  if (actor === null) throw failure("refused: --actor <seat> is required: name the seat running this", EXIT.DATAERR);
  if (args.verb === "withdraw") return withdrawDeposit(dir, args.id, { reason: args.reason, as: args.as, actor });
  if (args.verb === "restore") return restoreDeposit(dir, args.id, { as: args.as, actor });
  const items = await withdrawMatching(dir, { asker: args.as, actor, keys: args.keys, reason: args.reason, dryRun: args.dryRun });
  return { outcome: args.dryRun ? "would-withdraw" : "withdrawn", items: items.map(({ id, summary }) => ({ id, summary })) };
}

function text(report: Report): string {
  if ("items" in report) return [...report.items.map((item) => `${item.id}  ${item.summary}`), `${report.outcome}: ${report.items.length}`].join("\n");
  return `${report.id}\n${report.outcome}`;
}

export async function inboxWithdrawCli(config: ConsoleConfig, args: InboxWithdrawArgs): Promise<void> {
  await runVerb(
    () => run(config.inboxDir, args).catch(asExit),
    (result) => (args.json ? JSON.stringify(result) : text(result)),
  );
}
