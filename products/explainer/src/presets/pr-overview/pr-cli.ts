import { appDirs } from "@titan-design/app-paths";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { briefRunStart } from "../../workflow/brief-run.js";
import type { RunHost } from "../../workflow/host.js";
import { pairs } from "../../workflow/run-cli.js";
import type { CallEdgeReader } from "./call-edges.js";
import { gatherPr, writeGather } from "./gather.js";
import type { GhRun } from "./pr-read.js";
import { runPrVideoTrigger, shepherdWaiting, type TriggerRow } from "./trigger.js";

/** Every outside reader is injectable, so the CLI runs on a fake gh, fake Shepherd and fake call graph in a test. */
export interface PrCliDeps {
  gh?: GhRun;
  callEdges?: CallEdgeReader;
  readWaiting?: (port?: number) => Promise<unknown>;
  /** The decision-brief run's host, but its data dir; tests pass fake models and a fake clone. */
  host?: Omit<RunHost, "dataDir">;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

type Io = Required<Pick<PrCliDeps, "out" | "err">>;

function port(text: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError(`--port needs a positive integer, got "${text}"`);
  return n;
}

const readers = (deps: PrCliDeps) => ({ ...(deps.gh ? { gh: deps.gh } : {}), ...(deps.callEdges ? { callEdges: deps.callEdges } : {}) });

function gatherCommand(deps: PrCliDeps, io: Io, exit: { code: number }): Command {
  return new Command("gather")
    .description("On request: gather one PR's facts.jsonl (diff, review findings, calls across changed files) into --out")
    .argument("<pr>", "owner/repo#N")
    .requiredOption("--clone <dir>", "a clone of the repo holding the PR's head commit")
    .requiredOption("--out <dir>", "where facts.jsonl and gather.json are written")
    .exitOverride()
    .action(async (pr: string, flags: { clone: string; out: string }) => {
      const result = await gatherPr({ pr, clonePath: flags.clone, ...readers(deps) });
      await writeGather(flags.out, result);
      for (const d of result.diagnostics) (d.severity === "error" ? io.err : io.out)(`${d.code} ${d.message}\n`);
      if (result.ok) io.out(`gathered ${result.facts.length} facts for ${result.pr} at ${result.head}\n`);
      exit.code = result.ok ? 0 : 1;
    });
}

const rowLine = (row: TriggerRow): string => `${row.outcome} ${row.pr} ${row.head.slice(0, 12)} ${row.dir}\n`;

function triggerCommand(deps: PrCliDeps, io: Io, exit: { code: number }): Command {
  return new Command("trigger")
    .description("Start a decision-brief run (gather, then audition) for each PR held at the owner's visual gate (visual-gate2); no other PR auto-starts")
    .option("--data-dir <dir>", "where pr-briefs/ is written (default: the per-user data dir)")
    .option("--clone <repo=dir>", "the clone to index for a repo (repeatable)", pairs("--clone", (_repo, dir) => dir), {})
    .option("--port <n>", "port titan-factory serve listens on", port)
    .option("--dry-run", "list what would start and start nothing")
    .option("--json", "print the rows as JSON")
    .exitOverride()
    .action(async (flags: { dataDir?: string; clone: Record<string, string>; port?: number; dryRun?: boolean; json?: boolean }) => {
      const dataDir = flags.dataDir ?? appDirs("explainer").data;
      const { gh, ...rest } = readers(deps);
      const host: RunHost = { ...deps.host, dataDir, gather: { ...(gh ? { prGh: gh } : {}), ...rest, ...deps.host?.gather } };
      const rows = await runPrVideoTrigger({
        dataDir,
        readWaiting: () => (deps.readWaiting ?? shepherdWaiting)(flags.port),
        start: briefRunStart(host, (repo) => flags.clone[repo]),
        dryRun: flags.dryRun ?? false,
      });
      if (flags.json) io.out(`${JSON.stringify(rows, null, 2)}\n`);
      else if (rows.length === 0) io.out("no PR is held at the visual gate\n");
      else for (const row of rows) io.out(rowLine(row));
      exit.code = rows.some((row) => row.outcome === "refused") ? 1 : 0;
    });
}

/** `explainer pr gather|trigger`: exit 0 on success, 1 on a refusal or error, 2 on usage. */
export async function runPrCli(argv: readonly string[], deps: PrCliDeps = {}): Promise<number> {
  const io: Io = { out: deps.out ?? ((text) => process.stdout.write(text)), err: deps.err ?? ((text) => process.stderr.write(text)) };
  const exit = { code: 0 };
  const pr = new Command("pr").description("PR videos: gather on request, and the visual-gate trigger").exitOverride()
    .addCommand(gatherCommand(deps, io, exit)).addCommand(triggerCommand(deps, io, exit));
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: io.out, writeErr: io.err }).addCommand(pr);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return exit.code;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    io.err(`pr: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
