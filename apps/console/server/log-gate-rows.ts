/**
 * Shepherd's auto-by-rec rows for the #/log page (TP-6775). The console does not import titan-factory, so it runs the
 * installed CLI, `titan-factory shepherd by-rec --json`, with a fixed argv and no shell, and keeps each row that parses
 * as `titan/auto-by-rec@1`. A missing CLI, a failed run or a reply of another shape is a gap line, never an error, so the
 * page still shows the ships and the console's own rows.
 */
import { execFile } from "node:child_process";
import { z } from "zod";
import { byRecRowSchema, type ByRecRow } from "@titan-design/owner-queue";

export const FACTORY_NOT_FOUND = "titan-factory is not on PATH, so Shepherd's by-rec rows are not shown; set TITAN_CONSOLE_FACTORY_BIN to its absolute path";
const CLI_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** What the CLI needs to find its database and run node; the daemon's own settings, tokens included, stay behind. */
const CHILD_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"];

export interface GateRowsRead {
  rows: ByRecRow[];
  gaps: string[];
}

/** `days` bounds the read to rows resolved in that many days back from now. */
export type GateRowsSource = (days: number) => Promise<GateRowsRead>;

const reply = z.object({ rows: z.array(z.unknown()) });

/** Rows that fail the schema are counted in one gap line rather than dropped silently. */
export function parseGateRows(stdout: string): GateRowsRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { rows: [], gaps: ["shepherd by-rec: the reply was not JSON"] };
  }
  const shaped = reply.safeParse(parsed);
  if (!shaped.success) return { rows: [], gaps: ["shepherd by-rec: the reply has no rows list"] };
  const rows = shaped.data.rows.flatMap((row) => byRecRowSchema.safeParse(row).data ?? []);
  const dropped = shaped.data.rows.length - rows.length;
  return { rows, gaps: dropped === 0 ? [] : [`shepherd by-rec: ${dropped} row(s) did not match titan/auto-by-rec@1`] };
}

function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && CHILD_ENV.includes(name)));
}

export function factoryGateRows(bin: string | undefined): GateRowsSource {
  if (bin === undefined) return async () => ({ rows: [], gaps: [FACTORY_NOT_FOUND] });
  return (days) =>
    new Promise((resolve) => {
      const args = ["shepherd", "by-rec", "--json", "--since", `${days}d`];
      execFile(bin, args, { timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", env: childEnv() }, (error, stdout, stderr) => {
        if (error === null) return resolve(parseGateRows(stdout));
        const why = error.killed ? `took over ${CLI_TIMEOUT_MS / 1000} s and was stopped` : (stderr.trim().split("\n")[0] ?? error.message) || error.message;
        resolve({ rows: [], gaps: [`shepherd by-rec: ${why}`] });
      });
    });
}
