import type { Command } from "commander";
import type { Verbs } from "./cli-types.js";
import { EXIT } from "./exit-codes.js";
import { errorMessage } from "./narrow.js";
import { activeWorkOrigin } from "./shepherd/cleanup-ports.js";
import { formatTaskKeyReport, readRegistrationTasks, taskKeyReport } from "./shepherd/task-key-report.js";
import { loadTaskIndex, type TaskIndexLookup } from "./shepherd/task-ref.js";

async function run(opts: { json?: boolean }, { io, deps, dbPath }: Verbs): Promise<number> {
  let registrations: ReturnType<typeof readRegistrationTasks>;
  try {
    registrations = readRegistrationTasks(dbPath());
  } catch (error) {
    return (io.stderr(`error: cannot read the store at ${dbPath()}: ${errorMessage(error)}\n`), EXIT.USAGE);
  }
  let lookup: TaskIndexLookup;
  try {
    lookup = await loadTaskIndex({ origin: activeWorkOrigin(io.env), ...(deps.fetch && { fetch: deps.fetch }) });
  } catch (error) {
    return (io.stderr(`error: ${errorMessage(error)}\n`), EXIT.UNAVAILABLE);
  }
  const report = taskKeyReport(registrations, lookup);
  io.stdout(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatTaskKeyReport(report));
  return EXIT.OK;
}

/** TP-5453 P5: a one-off, read-only look at registrations whose task key is not canonical; it proposes and never rewrites. */
export function registerShepherdTaskKeyReport(shepherd: Command, verbs: Verbs): void {
  shepherd
    .command("task-key-report")
    .description("list every Shepherd registration whose task key is not <initiative>/<ID>, with the key its task id resolves to or no match, and the counts; opens the store read-only and changes nothing")
    .option("--json", "print the report as JSON")
    .action(async (opts: { json?: boolean }) => verbs.setExit(await run(opts, verbs)));
}
