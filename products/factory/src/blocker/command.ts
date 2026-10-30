import { fromDeposit, type OwnerItem } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { withdrawMatching } from "@titan-design/owner-queue/withdraw";
import { EXIT } from "@titan-design/registry";
import type { Command } from "commander";
import type { Verbs } from "../cli.js";
import { ownerInboxDir } from "../deploy-watch-ports.js";
import { parseSinceOption } from "../digest/command.js";
import { blockerDeposit, blockerItemId, blockerKey, MAX_OPEN_PER_ASKER, openBlockers, openDeposits, type BlockerRaise } from "./deposit.js";

type RaiseOpts = Omit<BlockerRaise, "asker" | "since" | "keys" | "expiresAt"> & { as: string; since?: number; key: string[]; expires?: string; json?: boolean };
interface ClearOpts { as: string; slug: string; actor: string; reason: string; json?: boolean }
interface ListOpts { as?: string; json?: boolean }

const message = (error: unknown): string => (error instanceof Error ? error.message.replace(/\s+/g, " ").trim() : String(error));

function refuse(verbs: Verbs, text: string, code: number = EXIT.DATAERR): void {
  verbs.io.stderr(`error: ${text}\n`);
  verbs.setExit(code);
}

function report(verbs: Verbs, json: boolean | undefined, payload: Record<string, unknown>, line: string): void {
  verbs.io.stdout(json ? `${JSON.stringify(payload)}\n` : `${line}\n`);
}

function toRaise({ as, since, key, expires, ...rest }: RaiseOpts, now: number): BlockerRaise {
  return { ...rest, asker: as, since: new Date(now - (since ?? 0) * 60_000), keys: key, ...(expires !== undefined && { expiresAt: expires }) };
}

/** A repeat raise of an open blocker keeps its first `since`; one that was cleared or answered must take a new slug. */
async function raiseAction(verbs: Verbs, opts: RaiseOpts, now: number): Promise<void> {
  const dir = ownerInboxDir(verbs.io.env);
  const deposit = blockerDeposit(toRaise(opts, now));
  try {
    fromDeposit(deposit, new Date(now));
  } catch (error) {
    return refuse(verbs, `blocker refused: ${message(error)}`);
  }
  const id = blockerItemId(opts.as, opts.slug);
  const open = await openDeposits(dir);
  if (open.some((item) => item.id === id)) return report(verbs, opts.json, { id, outcome: "already-raised" }, `already raised ${id}`);
  const mine = open.filter((item) => item.asker === opts.as).map((item) => item.id);
  if (mine.length >= MAX_OPEN_PER_ASKER) {
    return refuse(verbs, `${opts.as} already has ${MAX_OPEN_PER_ASKER} open deposits; clear or withdraw one first: ${mine.join(" ")}`);
  }
  const { created } = await writeDeposit(dir, deposit);
  if (!created) return refuse(verbs, `blocker ${opts.slug} was already cleared or answered; raise it under a new slug`);
  report(verbs, opts.json, { id, outcome: "raised" }, `raised ${id}`);
}

/** Withdraws through the spool's audit path, so `withdrawals.jsonl` names the seat that cleared it beside the asker. */
async function clearAction(verbs: Verbs, opts: ClearOpts): Promise<void> {
  let cleared: OwnerItem[];
  try {
    cleared = await withdrawMatching(ownerInboxDir(verbs.io.env), { asker: opts.as, actor: opts.actor, keys: [blockerKey(opts.as, opts.slug)], reason: opts.reason });
  } catch (error) {
    return refuse(verbs, message(error));
  }
  if (cleared.length === 0) return refuse(verbs, `no open blocker ${opts.slug} raised by ${opts.as}`, EXIT.NOINPUT);
  const ids = cleared.map((item) => item.id);
  report(verbs, opts.json, { ids, outcome: "cleared" }, `cleared ${ids.join(" ")}`);
}

const ageOf = (since: string, now: number): string => `${Math.floor((now - Date.parse(since)) / 3_600_000)}h`;

async function listAction(verbs: Verbs, opts: ListOpts, now: number): Promise<void> {
  const blockers = openBlockers(await openDeposits(ownerInboxDir(verbs.io.env)), new Date(now)).filter((item) => opts.as === undefined || item.asker === opts.as);
  const rows = blockers.map(({ id, asker, summary, blocker }) => ({ id, asker, summary, since: blocker!.since, blocks: blocker!.blocks }));
  if (opts.json) return verbs.io.stdout(`${JSON.stringify(rows, null, 2)}\n`);
  verbs.io.stdout(rows.map((row) => `${ageOf(row.since, now)}\t${row.asker}\t${row.blocks}\t${row.id}\n`).join(""));
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

function registerRaise(blocker: Command, verbs: Verbs): void {
  blocker
    .command("raise")
    .description("file a blocker deposit; a repeat of an open slug keeps its first since")
    .requiredOption("--as <seat>", "the asker seat")
    .requiredOption("--slug <kebab>", "names this blocker for the asker; clear takes the same slug")
    .requiredOption("--blocks <text>", "one line: the lane, task or PR that cannot move")
    .requiredOption("--summary <text>", "one line for the owner")
    .option("--since <window>", "how long it has been blocked, like 90m, 6h or 2d (default now)", parseSinceOption)
    .option("--context <text>", "the detail behind the summary")
    .option("--kind <kind>", "decide, approve or do (default do)")
    .option("--command <cmd>", "the command the owner runs to unblock it")
    .option("--key <key>", "an extra relation key; repeatable", collect, [])
    .option("--initiative <slug>", "the initiative it belongs to")
    .option("--expires <iso>", "when the blocker lapses (default never)")
    .option("--json", "print the result as JSON")
    .action((opts: RaiseOpts) => raiseAction(verbs, opts, Date.now()));
}

/** `titan-factory blocker`: any seat raises a hard blocker on the owner inbox, and clears it when it moves. */
export function registerBlocker(program: Command, verbs: Verbs): void {
  const blocker = program.command("blocker").description("raise, clear and list hard blockers on the owner inbox spool");
  registerRaise(blocker, verbs);
  blocker
    .command("clear")
    .description("withdraw an open blocker, logging the actor beside the asker")
    .requiredOption("--as <seat>", "the asker seat that raised it")
    .requiredOption("--slug <kebab>", "the slug it was raised under")
    .requiredOption("--actor <seat>", "the seat running the clear")
    .option("--reason <reason>", "obsolete, resolved or superseded:<id>", "resolved")
    .option("--json", "print the result as JSON")
    .action((opts: ClearOpts) => clearAction(verbs, opts));
  blocker
    .command("list")
    .description("open blockers, oldest first: age, asker, blocks, id")
    .option("--as <seat>", "only this asker's blockers")
    .option("--json", "print the blockers as JSON")
    .action((opts: ListOpts) => listAction(verbs, opts, Date.now()));
}
