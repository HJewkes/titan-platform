/**
 * `titan-console rounds nudge [--json]` (TP-4044): the owner digest's round lines. Each round open over six hours with
 * no answer is printed once, ever: the pass writes its `nudged.json` marker, and a later pass skips it. A local verb,
 * never an RPC command, as it writes beside the rounds.
 */
import { runVerb } from "./cli-rounds.js";
import type { ConsoleConfig } from "./config.js";
import { claimNudges, type RoundNudge } from "./round-nudge.js";
import { readQueueRounds } from "./rounds.js";

/** Null for anything but the verb with at most `--json`. */
export function roundsNudgeArgs(argv: readonly string[]): { json: boolean } | null {
  if (argv[0] !== "rounds" || argv[1] !== "nudge") return null;
  const rest = argv.slice(2);
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--json")) return null;
  return { json: rest.length === 1 };
}

export async function nudgeRounds(roundsDir: string, now: Date): Promise<RoundNudge[]> {
  const { rounds } = await readQueueRounds({ dir: roundsDir });
  return claimNudges(roundsDir, rounds, now);
}

export async function nudgeRoundsCli(config: ConsoleConfig, { json }: { json: boolean }): Promise<void> {
  await runVerb(
    () => nudgeRounds(config.roundsDir, new Date()),
    (nudges) => (json ? JSON.stringify(nudges) : nudges.map((nudge) => nudge.line).join("\n") || "no round has waited over 6 h unnudged"),
  );
}
