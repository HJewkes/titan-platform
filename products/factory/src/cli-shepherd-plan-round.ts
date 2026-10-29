import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { EXIT } from "@titan-design/registry";
import type { Command } from "commander";
import { parsePositiveInt } from "./cli-options.js";
import type { CliIo, Verbs } from "./cli.js";
import { configPath, loadConfig } from "./config.js";
import type { CommandResult } from "./service-control.js";
import { runCommand } from "./service-ports.js";
import { parseNameStatus, verifyPlan } from "./shepherd/plan-round-verify.js";
import { planRound, PlanRoundRefused, readPlanBlock, type GitRead } from "./shepherd/plan-round.js";
import { loadSeatBook, lookupSeat } from "./shepherd/seats.js";

type Run = (file: string, args: readonly string[]) => Promise<CommandResult | undefined>;

/** Reads in the planner's checkout through `git -C`, so a ref is checked once per read and an absent path is told from a bad ref. */
export function checkoutGit(checkout: string, run: Run = runCommand): GitRead {
  const git = (...args: string[]) => run("git", ["-C", checkout, ...args]);
  const commit = async (ref: string): Promise<string> => {
    const resolved = await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    if (resolved?.code !== 0) throw new Error(`${ref} is not a commit in ${checkout}`);
    return resolved.stdout.trim();
  };
  const blob = async (ref: string, path: string): Promise<string | null> => {
    const parsed = await git("rev-parse", "--verify", "--quiet", `${await commit(ref)}:${path}`);
    return parsed?.code === 0 ? parsed.stdout.trim() : null;
  };
  const show = async (ref: string, path: string): Promise<string | null> => {
    const sha = await blob(ref, path);
    if (sha === null) return null;
    const shown = await git("cat-file", "blob", sha);
    if (shown?.code !== 0) throw new Error(`git cat-file blob ${ref}:${path} failed: ${shown?.stderr.trim() ?? "git is not on PATH"}`);
    return shown.stdout;
  };
  const diffNames = async (base: string, ref: string): Promise<string[]> => {
    const diff = await git("diff", "--name-status", "-M", "-z", `${base}...${ref}`);
    if (diff?.code !== 0) throw new Error(`git diff ${base}...${ref} failed: ${diff?.stderr.trim() ?? "git is not on PATH"}`);
    return parseNameStatus(diff.stdout);
  };
  return { show, blob, commit, diffNames };
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
  pinFrom?: string;
  verify?: string;
}

function failed(io: CliIo, error: unknown): number {
  io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  return error instanceof PlanRoundRefused ? EXIT.DATAERR : EXIT.GENERIC;
}

/** Prints the round.json on stdout and every note on stderr; a plan the guard could not honour exits 65 with nothing printed. */
export async function draftPlanRound(source: string, args: PlanRoundArgs, ports: PlanRoundPorts): Promise<number> {
  try {
    const plan = readPlanBlock(await ports.readPlan(source));
    const optional = {
      ...(args.supersedes.length > 0 && { supersedes: args.supersedes }),
      ...(args.storybookUrl && { storybookUrl: args.storybookUrl }),
      ...(args.pinFrom && { pinFrom: args.pinFrom }),
    };
    const options = { round: args.round, base: args.base, visualPaths: ports.visualPaths(plan.repo), ...optional };
    const result = await planRound(plan, options, ports.git(args.checkout ?? process.cwd()));
    for (const note of result.notes) ports.io.stderr(`note: ${note}\n`);
    if (result.round) ports.io.stdout(`${JSON.stringify(result.round, null, 2)}\n`);
    return EXIT.OK;
  } catch (error) {
    return failed(ports.io, error);
  }
}

/** `--verify <ref>`: exit 0 when the ref stays inside the plan, 1 with one stderr line per drift, 65 for a plan the guard could not honour. */
async function verifyPlanRound(source: string, ref: string, args: PlanRoundArgs, ports: PlanRoundPorts): Promise<number> {
  try {
    const plan = readPlanBlock(await ports.readPlan(source));
    const problems = await verifyPlan(plan, { source, ref, base: args.base }, ports.git(args.checkout ?? process.cwd()));
    for (const problem of problems) ports.io.stderr(`drift: ${problem}\n`);
    if (problems.length > 0) return EXIT.GENERIC;
    ports.io.stdout(`${ref} changes only planned paths, and each pinned file holds its planned blob\n`);
    return EXIT.OK;
  } catch (error) {
    return failed(ports.io, error);
  }
}

/** The verify reads a head against the plan's own pins, so a pin taken from another ref would check nothing. */
async function runPlanRound(source: string, args: PlanRoundArgs, ports: PlanRoundPorts): Promise<number> {
  if (args.verify === undefined) return draftPlanRound(source, args, ports);
  if (args.pinFrom === undefined) return verifyPlanRound(source, args.verify, args, ports);
  ports.io.stderr("error: --verify and --pin-from do not combine: verify the head against the plan, then re-ask with --pin-from\n");
  return EXIT.USAGE;
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
    .option("--pin-from <ref>", "the re-ask: pin each planned file to its blob at this ref, read in --checkout; the block gives no inline content")
    .option("--verify <ref>", "print no round; exit 1 when the ref changes a path the plan does not list or a pinned file's bytes drifted")
    .action(async (source: string, args: PlanRoundArgs) => {
      const ports: PlanRoundPorts = {
        io: verbs.io,
        readPlan: (from) => (from === "-" ? text(process.stdin) : readFile(from, "utf8")),
        git: (checkout) => checkoutGit(checkout),
        visualPaths: (repo) => seatVisualPaths(verbs.io.env, repo),
      };
      verbs.setExit(await runPlanRound(source, args, ports));
    });
}
