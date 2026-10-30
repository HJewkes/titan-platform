/**
 * `titan-console shipped build [--date <YYYY-MM-DD>] [--group <initiative>] [--dry-run] [--force] [--json]`: builds the
 * day's theme digest. The model call runs on whatever `CLAUDE_CONFIG_DIR` login the caller (the daily timer) gives it.
 */
import path from "node:path";
import { runAgent } from "@titan-design/agent";
import { ghCliWire, githubPort } from "@titan-design/github";
import { runVerb } from "./cli-rounds.js";
import type { ConsoleConfig } from "./config.js";
import { shepherdReader } from "./shepherd.js";
import { buildShipped, type ShippedBuildOptions, type ShippedBuildReport } from "./shipped-build.js";

interface ShippedBuildArgs extends ShippedBuildOptions {
  json: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SWITCHES = new Set(["--dry-run", "--force", "--json"]);

/** `shipped build` with each flag at most once, in any order; null for anything else. */
export function shippedBuildArgs(argv: readonly string[]): ShippedBuildArgs | null {
  if (argv[0] !== "shipped" || argv[1] !== "build") return null;
  const parsed: ShippedBuildArgs = { dryRun: false, force: false, json: false };
  const seen = new Set<string>();
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (SWITCHES.has(flag)) Object.assign(parsed, { [flag === "--dry-run" ? "dryRun" : flag.slice(2)]: true });
    else if ((flag === "--date" && DATE.test(argv[i + 1] ?? "")) || (flag === "--group" && (argv[i + 1] ?? "") !== "")) {
      Object.assign(parsed, { [flag.slice(2)]: argv[i + 1] });
      i += 1;
    } else return null;
  }
  return parsed;
}

function reportLine(report: ShippedBuildReport): string {
  const head = `shipped ${report.date}: ${report.outcome}, ${report.merged} merged, ${report.batches} batches, ${report.calls} calls, ${report.promptBytes} prompt bytes, ${report.unsummarized} unsummarized`;
  return report.forbidden ? `${head}; GitHub answered 403, so later PRs were left unread` : head;
}

export async function shippedBuildCli(config: ConsoleConfig, { json, ...options }: ShippedBuildArgs): Promise<void> {
  const deps = { shepherd: shepherdReader(config.factoryPort), github: githubPort(ghCliWire()), run: runAgent, dir: path.join(config.stateDir, "shipped"), now: Date.now() };
  await runVerb(
    () => buildShipped(deps, options),
    (report) => (json ? JSON.stringify(report) : reportLine(report)),
  );
}
