import { isAbsolute } from "node:path";
import { InvalidArgumentError, type Command } from "commander";

/** node's directory goes on the job's PATH, where ":" separates entries. */
export function parseNodePath(value: string): string {
  if (!isAbsolute(value)) throw new InvalidArgumentError("must be an absolute path");
  if (value.includes(":")) throw new InvalidArgumentError('must not contain ":"');
  return value;
}

export function parseSha(value: string): string {
  if (!/^[0-9a-f]{7,40}$/.test(value)) throw new InvalidArgumentError("expected a commit sha of 7 to 40 lowercase hex digits");
  return value;
}

export function parsePort(value: string): number {
  const port = Number(value);
  if (!/^[0-9]+$/.test(value) || port > 65_535) throw new InvalidArgumentError("expected a port number");
  return port;
}

const DURATION_UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

export function parseDuration(value: string): number {
  const match = /^([0-9]+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new InvalidArgumentError("expected a duration such as 45m, 90s or 1h");
  return Number(match[1]) * DURATION_UNIT_MS[match[2]!]!;
}

/** The `shepherd status` row filters; `statusNarrow` in shepherd/status-filter.ts applies them. */
export function withStatusFilters(command: Command): Command {
  return command
    .option("--active", "only runs not done, failed or cancelled")
    .option("--phase <a,b>", "only runs in one of these phases")
    .option("--branch-prefix <p>", "only runs whose branch starts with p, with or without the agent-chat/ prefix")
    .option("--task <id>", "only runs for this task: a bare ID in any initiative, or slug/ID");
}
