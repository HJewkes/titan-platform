import type { Command } from "commander";
import type { Verbs } from "./cli-types.js";
import { refusedWithoutServe } from "./cli-agent-env.js";
import { parsePort } from "./cli-options.js";
import { EXIT } from "./exit-codes.js";
import { FACTORY_PORT } from "./serve.js";
import type { FactoryRoutes } from "./host.js";
import { bumpConsumers, planConsumerBumps, type ConsumerBumpPorts } from "./shepherd/bump-consumers.js";
import { npmLatest } from "./shepherd/consumer-bump.js";
import { scratchLockfileRegen } from "./shepherd/lockfile-regen.js";
import type { ShepherdServices } from "./shepherd/services.js";

type Plans = Awaited<ReturnType<typeof planConsumerBumps>>;
type SweepNote = Awaited<ReturnType<typeof bumpConsumers>>[number];

const ALL_CURRENT = "every consumer is on npm latest";

/** `titan-factory release bump-consumers`: one consumer bump sweep by hand, or with --dry-run the PRs it would open and no write at all. */
export function registerRelease(program: Command, verbs: Verbs): void {
  program
    .command("release")
    .description("carry @titan-design releases into the repos that consume them")
    .command("bump-consumers")
    .description("open one bump PR per consumer behind npm latest and register it with Shepherd")
    .option("--dry-run", "list the PRs it would open and write nothing")
    .option("--port <n>", "port titan-factory serve listens on; an agent env refuses to open PRs here when none answers", parsePort, FACTORY_PORT)
    .action(async (opts: { dryRun?: boolean; port: number }) => {
      if (opts.dryRun) return verbs.setExit(await dryRun(verbs));
      if (await refusedWithoutServe(verbs, opts.port, "release bump-consumers")) return;
      await verbs.withHost(async (host, routes) => {
        const notes = await bumpConsumers(host, shepherdOf(routes), portsOf(verbs));
        verbs.io.stdout(formatNotes(notes));
        return notes.some((note) => note.error !== undefined) ? EXIT.UNAVAILABLE : EXIT.OK;
      });
    });
}

/** Never opens the database or runs an install, so a frozen host can still preview a sweep. */
async function dryRun(verbs: Verbs): Promise<number> {
  const routes: FactoryRoutes = typeof verbs.deps.routes === "function" ? verbs.deps.routes() : verbs.deps.routes;
  const plans = await planConsumerBumps(shepherdOf(routes), portsOf(verbs).registry);
  verbs.io.stdout(formatPlans(plans));
  return plans.notes.some((note) => "error" in note) ? EXIT.UNAVAILABLE : EXIT.OK;
}

function portsOf({ deps }: Verbs): ConsumerBumpPorts {
  return deps.consumerBump ?? { registry: npmLatest(), regen: scratchLockfileRegen() };
}

function shepherdOf(routes: FactoryRoutes): ShepherdServices {
  const shepherd = routes.shepherd;
  if (!shepherd) throw new Error("release bump-consumers needs Shepherd's GitHub port and seat book, and this factory has none");
  return shepherd;
}

function formatPlans({ bumps, notes }: Plans): string {
  const planned = bumps.map(({ repo, branch, tree, plan }) => `${repo}: open ${branch} into ${tree.ref} [${plan.edits.map((edit) => `${edit.name} ${edit.from} -> ${edit.to}`).join(", ")}]`);
  const failed = notes.flatMap((note) => ("error" in note ? [`${note.repo}: not read (${note.error})`] : []));
  return lines([...planned, ...failed]);
}

function formatNotes(notes: readonly SweepNote[]): string {
  return lines(
    notes.flatMap((note) => {
      if (note.error !== undefined) return [`${note.repo}: failed (${note.error})`];
      if (note.pr === undefined) return [];
      const what = note.skipped ? `PR #${note.pr} already ${note.skipped}` : `opened PR #${note.pr}`;
      return [`${note.repo}: ${what}${note.registered ? `, shepherd run ${note.registered}` : ""}`];
    }),
  );
}

function lines(found: readonly string[]): string {
  return `${(found.length > 0 ? found : [ALL_CURRENT]).join("\n")}\n`;
}
