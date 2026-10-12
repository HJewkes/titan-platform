import type { Command } from "commander";
import type { Verbs } from "./cli.js";
import { EXIT } from "./exit-codes.js";
import type { FactoryRoutes } from "./host.js";
import type { ShepherdServices } from "./shepherd/commands.js";
import { planAdoptions, sweepToolchain, type ToolchainPlans, type ToolchainSweepNote } from "./shepherd/toolchain-sweep.js";
import { dryRunLines } from "./workflows/toolchain-fanout.js";

/** `titan-factory toolchain fanout`: one toolchain sweep by hand, or with --dry-run the PRs it would open and no write at all. */
export function registerToolchain(program: Command, verbs: Verbs): void {
  program
    .command("toolchain")
    .description("keep consumer repos on titan-platform's canonical node and package manager")
    .command("fanout")
    .description("open one adoption PR per drifted consumer repo and register it with Shepherd")
    .option("--dry-run", "list the PRs it would open and write nothing")
    .action(async (opts: { dryRun?: boolean }) => {
      if (opts.dryRun) return verbs.setExit(await dryRun(verbs));
      await verbs.withHost(async (host, routes) => {
        const notes = await sweepToolchain(host, shepherdOf(routes));
        verbs.io.stdout(formatNotes(notes));
        return notes.some((note) => note.error !== undefined) ? EXIT.UNAVAILABLE : EXIT.OK;
      });
    });
}

/** Never opens the database, so a frozen host can still preview a fanout. */
async function dryRun({ io, deps }: Verbs): Promise<number> {
  const routes: FactoryRoutes = typeof deps.routes === "function" ? deps.routes() : deps.routes;
  const result = await planAdoptions(shepherdOf(routes).port);
  io.stdout(formatPlans(result));
  return result.errors.length > 0 ? EXIT.UNAVAILABLE : EXIT.OK;
}

function shepherdOf(routes: FactoryRoutes): ShepherdServices {
  const shepherd = routes.shepherd;
  if (!shepherd) throw new Error("toolchain fanout needs Shepherd's GitHub port, and this factory has none");
  return shepherd;
}

function formatPlans({ plans, errors }: ToolchainPlans): string {
  const lines = [...dryRunLines(plans), ...errors.map((entry) => `${entry.repo}: not read (${entry.error})`)];
  return `${(lines.length > 0 ? lines : ["every consumer matches the canonical toolchain"]).join("\n")}\n`;
}

function formatNotes(notes: readonly ToolchainSweepNote[]): string {
  const lines = notes.map((note) => {
    if (note.error !== undefined) return `${note.repo}: failed (${note.error})`;
    const what = note.skipped ? `PR #${note.pr} already ${note.skipped}` : `opened PR #${note.pr}`;
    return `${note.repo}: ${what}${note.registered ? `, shepherd run ${note.registered}` : ""}`;
  });
  return `${(lines.length > 0 ? lines : ["every consumer matches the canonical toolchain"]).join("\n")}\n`;
}
