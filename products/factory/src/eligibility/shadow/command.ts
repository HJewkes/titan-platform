import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import type { Verbs } from "../../cli-types.js";
import { EXIT } from "../../exit-codes.js";
import { errorMessage } from "../../narrow.js";
import { defaultRuleFilePath, loadRuleFile, type LoadedRules } from "./rule-file.js";
import type { ShadowRow } from "./row.js";
import { shadowTick } from "./tick.js";
import { appendShadowRows } from "./writer.js";

interface TickOptions {
  ruleFile?: string;
}

function summary(rows: readonly ShadowRow[], wake: string, file: string): string {
  const count = (kind: string) => rows.filter((row) => row.kind === kind).length;
  return `dispatcher shadow wake ${wake}: ${count("would-dispatch")} would-dispatch, ${count("refused")} refused -> ${file}\n`;
}

async function tick(loaded: LoadedRules, dir: string, verbs: Verbs): Promise<number> {
  const now = new Date();
  const wake = `${now.toISOString().slice(0, 19)}Z#${randomBytes(2).toString("hex")}`;
  const { rows, unreadLanes } = await shadowTick({ loaded, verbs, now, wake });
  verbs.io.stdout(summary(rows, wake, appendShadowRows(dir, now, rows)));
  if (unreadLanes > 0) verbs.io.stderr(`error: ${unreadLanes} lane(s) could not be read from active-work; each wrote a signal-unreadable row\n`);
  return unreadLanes > 0 ? EXIT.UNAVAILABLE : EXIT.OK;
}

async function runShadowTick(opts: TickOptions, verbs: Verbs): Promise<number> {
  let loaded: LoadedRules | undefined;
  try {
    loaded = loadRuleFile(opts.ruleFile ?? defaultRuleFilePath(verbs.io.env));
  } catch (error) {
    verbs.io.stderr(`error: ${errorMessage(error)}\n`);
    return EXIT.USAGE;
  }
  const dir = loaded?.rules.shadow.enabled === true ? loaded.rules.shadow.dir : undefined;
  if (loaded === undefined || dir === undefined) {
    verbs.io.stdout("dispatcher shadow disabled\n");
    return EXIT.OK;
  }
  try {
    return await tick(loaded, dir, verbs);
  } catch (error) {
    verbs.io.stderr(`error: ${errorMessage(error)}\n`);
    return EXIT.UNAVAILABLE;
  }
}

/** The shadow dispatcher's verbs under `dispatch`; later slices add theirs here, one line each. */
export function registerShadowVerbs(dispatch: Command, verbs: Verbs): void {
  dispatch
    .command("shadow-tick")
    .description("one shadow wake: judge every lane in the dispatcher rule file and append would-dispatch and refused rows to the shadow dir; dispatches nothing")
    .option("--rule-file <path>", "the dispatcher rule file (default: dispatcher.json beside the factory config.json)")
    .action(async (opts: TickOptions) => verbs.setExit(await runShadowTick(opts, verbs)));
}
