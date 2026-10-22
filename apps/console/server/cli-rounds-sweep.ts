/**
 * `titan-console rounds sweep [--dry-run|--apply] [--json] [--decisions <path>]` (TP-3990): a local verb, never an RPC
 * command, for the same reason as `rounds withdraw`. The decisions file is `--decisions`, else the console's
 * `TITAN_CONSOLE_DECISIONS_FILE`; with neither, only the structural rule runs.
 */
import path from "node:path";
import { runVerb } from "./cli-rounds.js";
import type { ConsoleConfig } from "./config.js";
import { sweepRounds, type SweepReport } from "./round-sweep.js";

interface SweepArgs {
  apply: boolean;
  json: boolean;
  decisions: string | null;
}

const MODE_FLAGS = new Set(["--dry-run", "--apply"]);

/** Null for anything else, including both modes at once or a repeated flag. */
export function roundsSweepArgs(argv: readonly string[]): SweepArgs | null {
  if (argv[0] !== "rounds" || argv[1] !== "sweep") return null;
  const rest = argv.slice(2);
  const at = rest.indexOf("--decisions");
  const decisions = at < 0 ? null : rest[at + 1];
  if (decisions === undefined || decisions?.startsWith("--")) return null;
  const flags = rest.filter((_, index) => at < 0 || (index !== at && index !== at + 1));
  const modes = flags.filter((flag) => MODE_FLAGS.has(flag));
  const known = flags.every((flag) => MODE_FLAGS.has(flag) || flag === "--json");
  if (!known || new Set(flags).size !== flags.length || modes.length > 1) return null;
  return { apply: modes[0] === "--apply", json: flags.includes("--json"), decisions };
}

function reportLines({ applied, superseded, decisions, gaps }: SweepReport): string[] {
  const supersededLines = superseded.flatMap(({ by, targets }) => targets.map((target) => `${by} supersedes ${target.id}: ${target.outcome}`));
  const decisionLines =
    decisions === null
      ? ["decisions: no decisions file; pass --decisions <path> or set TITAN_CONSOLE_DECISIONS_FILE"]
      : decisions.candidates.map(({ id, line, text, outcome }) => `${id}: ${outcome} (decisions line ${line}: ${text})`);
  return [
    ...supersededLines,
    ...decisionLines,
    ...gaps.map((gap) => `gap: ${gap}`),
    applied ? "applied" : "dry run: nothing written; --apply withdraws the rounds listed above",
  ];
}

export async function sweepRoundsCli(config: ConsoleConfig, { apply, json, decisions }: SweepArgs): Promise<void> {
  const decisionsFile = decisions === null ? config.decisionsFile : path.resolve(decisions);
  await runVerb(
    () => sweepRounds({ roundsDir: config.roundsDir, decisionsFile, apply, now: new Date() }),
    (report) => (json ? JSON.stringify(report) : reportLines(report).join("\n")),
  );
}
