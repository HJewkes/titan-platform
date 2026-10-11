import { isAbsolute } from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import { filterRows, parsePhases, type StatusFilter } from "./shepherd/status-filter.js";

export type { StatusFilter };

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

export function parsePositiveInt(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new InvalidArgumentError("expected a positive whole number");
  return Number(value);
}

/** The `shepherd status` row filters, parsed onto the verb's options as a `StatusFilter`. */
export function withStatusFilters(command: Command): Command {
  return command
    .option("--active", "only runs not done, failed or cancelled")
    .option("--phase <a,b>", "only runs in one of these phases", phaseList)
    .option("--branch-prefix <p>", "only runs whose branch starts with p, with or without the agent-chat/ prefix")
    .option("--task <id>", "only runs for this task: a bare ID in any initiative, or slug/ID");
}

function phaseList(value: string): ReturnType<typeof parsePhases> {
  try {
    return parsePhases(value);
  } catch (err) {
    throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
  }
}

/** Filters `status` rows here, not on serve, so an older serve that ignores unknown args still filters; no flag leaves the data untouched. */
export function statusRows(name: string, data: unknown, { active, phase, branchPrefix, task }: StatusFilter): unknown {
  const filter = { active, phase, branchPrefix, task };
  if (name !== "shepherd.status" || !Array.isArray(data) || Object.values(filter).every((value) => value === undefined)) return data;
  return filterRows(data, filter);
}
