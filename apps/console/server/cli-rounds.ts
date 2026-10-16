/**
 * `titan-console rounds import <round-dir> [--json]`: the one entry point for `importRound`'s write. It is a
 * local verb on purpose and never an RPC command, so nothing that reaches `/rpc` can land a round. It prints
 * the console's own URL for the round, never a review-harness port. `rounds withdraw` is local for the same
 * reason: nothing that reaches `/rpc` can take a question away from the owner.
 */
import type { ConsoleConfig } from "./config.js";
import { lanOrigin } from "./daemon.js";
import { importRound, type ImportResult } from "./round-import.js";
import { withdrawRound } from "./round-withdraw.js";

interface ImportReport extends ImportResult {
  url: string;
  lanUrl: string | null;
}

function reportOf(config: ConsoleConfig, result: ImportResult): ImportReport {
  const hash = `/#/rounds/${result.id}`;
  const lanUrl = config.lanHost === null ? null : `${lanOrigin(config, config.port)}${hash}`;
  return { ...result, url: `http://127.0.0.1:${config.port}${hash}`, lanUrl };
}

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
