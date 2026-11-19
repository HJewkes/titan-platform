import { dirname } from "node:path";
import type { Command } from "commander";
import type { CliIo } from "./cli-types.js";
import { parseSinceOption } from "./digest/command.js";
import { byRecLogPath, readByRecRows, rowsSince } from "./shepherd/by-rec-log.js";

interface ByRecOpts {
  json?: boolean;
  /** Minutes, parsed from `90m`, `6h` or `7d`. */
  since?: number;
}

function rowLine(row: ReturnType<typeof readByRecRows>[number]): string {
  return `${row.resolvedAt}  ${row.mode}  ${row.result}  ${row.subject.id}  ${row.subject.summary ?? "-"}  by ${row.recommendation.by}`;
}

/** TP-6772: the by-rec sweep's log, read from the file beside the database; read-only, so it needs no serve. */
export function registerShepherdByRec(shepherd: Command, io: CliIo, dbPath: () => string, now: () => number = Date.now): void {
  shepherd
    .command("by-rec")
    .description("every auto-by-rec row the approve-merge sweep wrote (would-resolve in shadow, resolved in live), oldest first; read-only")
    .option("--json", "print the rows as JSON")
    .option("--since <window>", "only rows resolved in this window back from now: 90m, 6h or 7d", parseSinceOption)
    .action((opts: ByRecOpts) => {
      const since = opts.since === undefined ? undefined : now() - opts.since * 60_000;
      const rows = rowsSince(readByRecRows(byRecLogPath(dirname(dbPath()))), since);
      if (opts.json) io.stdout(`${JSON.stringify({ rows }, null, 2)}\n`);
      else io.stdout(`${rows.length === 0 ? "no auto-by-rec rows" : rows.map(rowLine).join("\n")}\n`);
    });
}
