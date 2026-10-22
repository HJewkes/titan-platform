/**
 * `titan-console storybooks gc [--dry-run] [--json]`: runs the Storybook store's GC sweep (`storybook-gc.ts`) and
 * prints each build kept or removed, and why. It is local only, like `rounds import`: no `/rpc` command deletes a build,
 * and the daemon runs no sweep of its own.
 */
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { runVerb } from "./cli-rounds.js";
import type { ConsoleConfig } from "./config.js";
import { sweepStorybooks, type GcReport } from "./storybook-gc.js";

interface GcArgs {
  dryRun: boolean;
  json: boolean;
}

const GC_FLAGS = new Set(["--dry-run", "--json"]);

/** `storybooks gc [--dry-run] [--json]`, flags in any order, each at most once; null for anything else. */
export function storybooksGcArgs(argv: readonly string[]): GcArgs | null {
  if (argv[0] !== "storybooks" || argv[1] !== "gc") return null;
  const flags = argv.slice(2);
  if (!flags.every((flag) => GC_FLAGS.has(flag)) || new Set(flags).size !== flags.length) return null;
  return { dryRun: flags.includes("--dry-run"), json: flags.includes("--json") };
}

const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

function gcLines(report: GcReport): string[] {
  const verb = report.dryRun ? { removed: "would remove", kept: "keep" } : { removed: "removed", kept: "kept" };
  return [
    ...report.builds.map((entry) => `${verb[entry.action]} ${entry.buildId} (${mb(entry.bytes)}): ${entry.reason}`),
    ...report.skipped.map((name) => `skipped ${name}: not a build`),
    ...(report.blocked === null ? [] : [`blocked: ${report.blocked}`]),
    `store: ${mb(report.bytesAfter)} of a ${mb(report.capBytes)} cap (${mb(report.bytesBefore)} before)${report.dryRun ? "; dry run, nothing deleted" : ""}`,
  ];
}

const noStore = (): never => {
  throw failure("storybooks gc: this console has no Storybook store", EXIT.NOINPUT);
};

/** A blocked sweep still prints its report, and exits 65 so a timer or seat sees it removed nothing. */
export async function storybooksGcCli(config: ConsoleConfig, { dryRun, json }: GcArgs, now: Date = new Date()): Promise<void> {
  await runVerb(
    async () => {
      const storybooksDir = config.storybooksDir ?? noStore();
      const report = await sweepStorybooks({ storybooksDir, roundsDir: config.roundsDir, dryRun, now });
      if (report.blocked !== null) process.exitCode = EXIT.DATAERR;
      return report;
    },
    (report) => (json ? JSON.stringify(report) : gcLines(report).join("\n")),
  );
}
