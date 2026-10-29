import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { EXIT } from "@titan-design/registry";
import type { Command } from "commander";
import { parsePositiveInt } from "./cli-options.js";
import type { CliIo, Verbs } from "./cli.js";
import { configPath, loadConfig } from "./config.js";
import type { CommandResult } from "./service-control.js";
import { runCommand } from "./service-ports.js";
import { planRound, PlanRoundRefused, readPlanBlock, type GitRead } from "./shepherd/plan-round.js";
import { loadSeatBook, lookupSeat } from "./shepherd/seats.js";

type Run = (file: string, args: readonly string[]) => Promise<CommandResult | undefined>;

/** Reads in the planner's checkout through `git -C`, so a ref is checked once per read and an absent path is told from a bad ref. */
export function checkoutGit(checkout: string, run: Run = runCommand): GitRead {
  const git = (...args: string[]) => run("git", ["-C", checkout, ...args]);
  return {
    show: async (ref, path) => {
      const commit = await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
      if (commit?.code !== 0) throw new Error(`${ref} is not a commit in ${checkout}`);
      if ((await git("cat-file", "-e", `${ref}:${path}`))?.code !== 0) return null;
      const shown = await git("cat-file", "blob", `${ref}:${path}`);
      if (shown?.code !== 0) throw new Error(`git cat-file blob ${ref}:${path} failed: ${shown?.stderr.trim() ?? "git is not on PATH"}`);
      return shown.stdout;
    },
  };
}

/** What one draft reads; tests swap in their own. */
export interface PlanRoundPorts {
  io: CliIo;
  readPlan: (source: string) => Promise<string>;
  git: (checkout: string) => GitRead;
  /** The `visual_paths` of the seat owning `repo`, read from the seat book the guard reads. */
  visualPaths: (repo: string) => readonly string[] | undefined;
}

export interface PlanRoundArgs {
  round: number;
  supersedes: string[];
  checkout?: string;
  base: string;
  storybookUrl?: string;
}

/** Prints the round.json on stdout and every note on stderr; a plan the guard could not honour exits 65 with nothing printed. */
export async function draftPlanRound(source: string, args: PlanRoundArgs, ports: PlanRoundPorts): Promise<number> {
  try {
    const plan = readPlanBlock(await ports.readPlan(source));
    const optional = { ...(args.supersedes.length > 0 && { supersedes: args.supersedes }), ...(args.storybookUrl && { storybookUrl: args.storybookUrl }) };
    const options = { round: args.round, base: args.base, visualPaths: ports.visualPaths(plan.repo), ...optional };
    const result = await planRound(plan, options, ports.git(args.checkout ?? process.cwd()));
    for (const note of result.notes) ports.io.stderr(`note: ${note}\n`);
    if (result.round) ports.io.stdout(`${JSON.stringify(result.round, null, 2)}\n`);
    return EXIT.OK;
  } catch (error) {
    ports.io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof PlanRoundRefused ? EXIT.DATAERR : EXIT.GENERIC;
  }
}

function seatVisualPaths(env: NodeJS.ProcessEnv, repo: string): readonly string[] | undefined {
  const found = lookupSeat(loadSeatBook(loadConfig(configPath(env)).shepherd ?? {}), repo);
  return found.kind === "seat" ? found.seat.visualPaths : undefined;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** `shepherd plan-round`: drafts only. It never reaches serve, the store or the console; the coordinator pipes it to `titan-console decisions file -`. */
export function registerShepherdPlanRound(shepherd: Command, verbs: Verbs): void {
  shepherd
    .command("plan-round <plan>")
    .description("print one PR's plan round.json from a plan.md's ```plan-round fence, a JSON file or - (stdin), binding each WHAT gate its planned files would hit; writes nothing")
    .option("--round <n>", "the round number", parsePositiveInt, 1)
    .option("--supersedes <round-id>", "a console round this one replaces; repeatable", collect, [])
    .option("--checkout <dir>", "the checkout --base is read in (default: the current directory)")
    .option("--base <ref>", "the ref each pinned file's diff is shown against", "origin/main")
    .option("--storybook-url <url>", "the loopback Storybook URL round@2 requires (default http://127.0.0.1:6006/)")
    .action(async (source: string, args: PlanRoundArgs) => {
      const ports: PlanRoundPorts = {
        io: verbs.io,
        readPlan: (from) => (from === "-" ? text(process.stdin) : readFile(from, "utf8")),
        git: (checkout) => checkoutGit(checkout),
        visualPaths: (repo) => seatVisualPaths(verbs.io.env, repo),
      };
      verbs.setExit(await draftPlanRound(source, args, ports));
    });
}
