import type { Command } from "commander";
import type { Verbs } from "../../cli-types.js";
import { EXIT } from "../../exit-codes.js";
import { errorMessage } from "../../narrow.js";
import { activeWorkOrigin } from "../../shepherd/cleanup-ports.js";
import { defaultRuleFilePath, loadRuleFile } from "../shadow/rule-file.js";
import { applyImport, importPlan, PlanCommandsMissing, type ImportCall } from "./import.js";
import { defaultDigestDir, readSheetDir, type SheetFile } from "./sheet-dir.js";

interface DirOptions {
  ruleFile?: string;
  dir?: string;
  digests?: string;
}

interface ImportOptions extends DirOptions {
  dryRun?: boolean;
  apply?: boolean;
}

/** `--dir`, else the rule file's `bets.sheetDir`; digests from `--digests`, `bets.digestDir`, or beside the sheets. */
function sheetDirs(opts: DirOptions, verbs: Verbs): { sheetDir: string; digestDir: string } {
  const bets = opts.dir === undefined ? loadRuleFile(opts.ruleFile ?? defaultRuleFilePath(verbs.io.env))?.rules.bets : undefined;
  const sheetDir = opts.dir ?? bets?.sheetDir;
  if (sheetDir === undefined) throw new Error("no sheet dir: pass --dir, or set bets.sheetDir in the dispatcher rule file");
  return { sheetDir, digestDir: opts.digests ?? bets?.digestDir ?? defaultDigestDir(sheetDir) };
}

function readSheets(opts: DirOptions, verbs: Verbs): SheetFile[] | undefined {
  try {
    const { sheetDir, digestDir } = sheetDirs(opts, verbs);
    return readSheetDir(sheetDir, digestDir);
  } catch (error) {
    verbs.io.stderr(`error: ${errorMessage(error)}\n`);
    return undefined;
  }
}

function checkLines({ file, result }: SheetFile): string[] {
  if (!result.ok) return result.errors.map((error) => `FAIL ${file}:${error.line}: ${error.message}`);
  const { front, bets } = result.sheet;
  const tasks = new Set(bets.flatMap((bet) => bet.tasks ?? [])).size;
  return [`ok   ${file}: ${bets.length} bets, ${tasks} tasks (lane ${front.lane ?? "(whole initiative)"}, week ${front.week})`];
}

function runCheck(opts: DirOptions, verbs: Verbs): number {
  const sheets = readSheets(opts, verbs);
  if (sheets === undefined) return EXIT.USAGE;
  for (const sheet of sheets) verbs.io.stdout(checkLines(sheet).map((line) => `${line}\n`).join(""));
  if (sheets.length === 0) verbs.io.stdout("no bet sheets\n");
  return sheets.every((sheet) => sheet.result.ok) ? EXIT.OK : EXIT.REFUSED;
}

/** Every call for every sheet, or undefined after printing why the sheets cannot be imported as written. */
function plannedCalls(sheets: readonly SheetFile[], verbs: Verbs): ImportCall[] | undefined {
  const calls: ImportCall[] = [];
  const problems: string[] = [];
  for (const { file, result } of sheets) {
    if (!result.ok) problems.push(...checkLines({ file, result }));
    else {
      const plan = importPlan(result.sheet);
      calls.push(...plan.calls);
      problems.push(...plan.problems.map((problem) => `FAIL ${file}: ${problem}`));
    }
  }
  if (problems.length === 0) return calls;
  verbs.io.stderr(`${problems.join("\n")}\nerror: nothing imported; fix the sheets and import again\n`);
  return undefined;
}

async function apply(calls: readonly ImportCall[], verbs: Verbs): Promise<number> {
  try {
    await applyImport({ origin: activeWorkOrigin(verbs.io.env), ...(verbs.deps.fetch && { fetch: verbs.deps.fetch }) }, calls);
  } catch (error) {
    verbs.io.stderr(`error: ${errorMessage(error)}\n`);
    return error instanceof PlanCommandsMissing ? EXIT.UNAVAILABLE : EXIT.FAILURE;
  }
  verbs.io.stdout(`imported ${calls.length} record(s) as draft outcomes and proposed bets\n`);
  return EXIT.OK;
}

async function runImport(opts: ImportOptions, verbs: Verbs): Promise<number> {
  if (opts.dryRun === opts.apply) {
    verbs.io.stderr("error: pass exactly one of --dry-run or --apply\n");
    return EXIT.USAGE;
  }
  const sheets = readSheets(opts, verbs);
  if (sheets === undefined) return EXIT.USAGE;
  const calls = plannedCalls(sheets, verbs);
  if (calls === undefined) return EXIT.REFUSED;
  verbs.io.stdout(calls.map((call) => `${opts.apply ? "" : "would call "}${call.command} ${JSON.stringify(call.args)}\n`).join(""));
  return opts.apply ? apply(calls, verbs) : EXIT.OK;
}

const withDirs = (command: Command): Command =>
  command
    .option("--rule-file <path>", "the dispatcher rule file whose bets.sheetDir names the sheets (default: dispatcher.json beside the factory config.json)")
    .option("--dir <sheetDir>", "the bet sheet directory, instead of the rule file's")
    .option("--digests <dir>", "the intent digest directory (default: the rule file's bets.digestDir, else digests beside the sheet dir)");

/** `dispatch sheets check|import`: read and import the phase-2 bet sheets; nothing here selects a bet. */
export function registerSheetVerbs(dispatch: Command, verbs: Verbs): void {
  const sheets = dispatch.command("sheets").description("phase-2 bet sheets (titan-bet-sheet/v1): check them, or import them as draft outcomes and proposed bets");
  withDirs(sheets.command("check").description("parse every sheet and check its cites against its digest; one line per sheet, non-zero on any error")).action((opts: DirOptions) =>
    verbs.setExit(runCheck(opts, verbs)),
  );
  withDirs(sheets.command("import").description("write each sheet as a draft outcome and proposed bets through active-work (plan.outcome.add, plan.bet.add)"))
    .option("--dry-run", "print the calls and make none")
    .option("--apply", "make the calls")
    .action(async (opts: ImportOptions) => verbs.setExit(await runImport(opts, verbs)));
}
