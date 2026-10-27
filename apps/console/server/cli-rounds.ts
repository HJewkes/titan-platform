/**
 * `titan-console rounds import <round-dir> [--json]`: the one entry point for `importRound`'s write. It is a
 * local verb on purpose and never an RPC command, so nothing that reaches `/rpc` can land a round. It prints
 * the console's own URL for the round, never a review-harness port. `rounds withdraw` is local for the same
 * reason: nothing that reaches `/rpc` can take a question away from the owner. `decisions file` lands a seat's
 * questions-only round the same way, so it too needs no running console.
 */
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import type { ConsoleConfig } from "./config.js";
import { lanOrigin } from "./daemon.js";
import { fileRound, type FileResult } from "./round-file.js";
import { importRound, type ImportResult } from "./round-import.js";
import { withdrawRound } from "./round-withdraw.js";

interface RoundUrls {
  url: string;
  lanUrl: string | null;
}

type ImportReport = ImportResult & RoundUrls;

function urlsOf(config: ConsoleConfig, id: string): RoundUrls {
  const hash = `/#/rounds/${id}`;
  const lanUrl = config.lanHost === null ? null : `${lanOrigin(config, config.port)}${hash}`;
  return { url: `http://127.0.0.1:${config.port}${hash}`, lanUrl };
}

const reportOf = (config: ConsoleConfig, result: ImportResult): ImportReport => ({ ...result, ...urlsOf(config, result.id) });

function textLines({ id, frames, feedback, url, lanUrl }: ImportReport): string[] {
  return [id, `frames: ${frames}`, `feedback: ${feedback}`, url, ...(lanUrl === null ? [] : [lanUrl])];
}

interface ImportArgs {
  dir: string;
  json: boolean;
}

/** `rounds import <round-dir>` with an optional `--json` on either side of the dir; null for anything else. */
export function roundsImportArgs(argv: readonly string[]): ImportArgs | null {
  if (argv[0] !== "rounds" || argv[1] !== "import") return null;
  const rest = argv.slice(2);
  const dirs = rest.filter((arg) => arg !== "--json");
  const [dir] = dirs;
  if (dir === undefined || dirs.length !== 1 || rest.length > 2) return null;
  return { dir, json: rest.length === 2 };
}

const fail = (message: string, code: number): never => {
  throw failure(message, code);
};

const exitCodeOf = (error: unknown): number =>
  error instanceof Error && "code" in error && typeof error.code === "number" ? error.code : 1;

/** A refusal prints its reason to stderr and nothing to stdout, and exits with the refusal's code. */
async function runVerb<T>(run: () => Promise<T>, print: (result: T) => string): Promise<void> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = exitCodeOf(error);
    return;
  }
  console.log(print(result));
}

export async function importRoundCli(config: ConsoleConfig, { dir, json }: ImportArgs): Promise<void> {
  await runVerb(
    async () => reportOf(config, await importRound({ source: dir, roundsDir: config.roundsDir })),
    (report) => (json ? JSON.stringify(report) : textLines(report).join("\n")),
  );
}

interface WithdrawArgs {
  id: string;
  reason: string;
  json: boolean;
}

/** `rounds withdraw <id> --reason <reason> [--json]`, flags in any order after the verb; null for anything else. */
export function roundsWithdrawArgs(argv: readonly string[]): WithdrawArgs | null {
  if (argv[0] !== "rounds" || argv[1] !== "withdraw") return null;
  const rest = argv.slice(2);
  const at = rest.indexOf("--reason");
  const reason = at < 0 ? undefined : rest[at + 1];
  if (reason === undefined || reason.startsWith("--")) return null;
  const others = rest.filter((_, index) => index !== at && index !== at + 1);
  const ids = others.filter((arg) => arg !== "--json");
  const [id] = ids;
  if (id === undefined || ids.length !== 1 || others.length > 2 || id.startsWith("--")) return null;
  return { id, reason, json: others.length === 2 };
}

export async function withdrawRoundCli(config: ConsoleConfig, { id, reason, json }: WithdrawArgs): Promise<void> {
  await runVerb(
    () => withdrawRound(config.roundsDir, id, reason),
    (result) => (json ? JSON.stringify(result) : `${result.id}\n${result.outcome}`),
  );
}

interface DecisionsFileArgs {
  /** A round.json path, or "-" for stdin. */
  source: string;
  seat: string | null;
  initiative: string | null;
  json: boolean;
}

const VALUE_FLAGS = new Set(["--seat", "--initiative"]);

/** Splits `--seat <s>` and `--initiative <i>` from the rest; null when a value flag repeats or has no value. */
function valueFlags(rest: readonly string[]): { values: Map<string, string>; others: string[] } | null {
  const values = new Map<string, string>();
  const others: string[] = [];
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at];
    if (arg === undefined) break;
    if (!VALUE_FLAGS.has(arg)) {
      others.push(arg);
      continue;
    }
    const value = rest[at + 1];
    if (value === undefined || value.startsWith("--") || values.has(arg)) return null;
    values.set(arg, value);
    at += 1;
  }
  return { values, others };
}

/**
 * `decisions file [<round.json>|-] [--seat <name>] [--initiative <slug>] [--json]`, flags in any order; null for anything
 * else. With no source the round comes from stdin, and with no `--seat` the seat is `AGENT_CHAT_NAME`.
 */
export function decisionsFileArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): DecisionsFileArgs | null {
  if (argv[0] !== "decisions" || argv[1] !== "file") return null;
  const split = valueFlags(argv.slice(2));
  if (split === null) return null;
  const sources = split.others.filter((arg) => arg !== "--json");
  const json = split.others.length - sources.length;
  if (json > 1 || sources.length > 1 || sources.some((arg) => arg.startsWith("--"))) return null;
  const seat = split.values.get("--seat") ?? (env.AGENT_CHAT_NAME || null);
  return { source: sources[0] ?? "-", seat, initiative: split.values.get("--initiative") ?? null, json: json === 1 };
}

type DecisionReport = FileResult & RoundUrls;

const decisionLines = ({ id, seat, initiative, url, lanUrl }: DecisionReport): string[] => [
  id,
  `asked by: ${seat}${initiative === null ? "" : ` (${initiative})`}`,
  url,
  ...(lanUrl === null ? [] : [lanUrl]),
];

/** `readBody` gives the stdin text for "-", and the file's for a path; the round is judged only by `fileRound`. */
export async function fileDecisionCli(config: ConsoleConfig, args: DecisionsFileArgs, readBody: (source: string) => Promise<string>): Promise<void> {
  await runVerb(
    async () => {
      const seat = args.seat ?? fail("decision round refused: name the asking seat with --seat <name> (or set AGENT_CHAT_NAME)", EXIT.USAGE);
      const body = await readBody(args.source).catch(() => fail(`decision round refused: ${args.source} could not be read`, EXIT.NOINPUT));
      const filed = await fileRound({ body, roundsDir: config.roundsDir, asker: { seat, initiative: args.initiative } });
      return { ...filed, ...urlsOf(config, filed.id) };
    },
    (report) => (args.json ? JSON.stringify(report) : decisionLines(report).join("\n")),
  );
}
