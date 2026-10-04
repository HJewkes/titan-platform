import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowStatus } from "@titan-design/workflow";
import type { Command } from "commander";
import type { CliIo } from "./cli.js";
import { SHEPHERD_WORKFLOW } from "./shepherd/commands.js";
import { shepherdStats, type StatsRow } from "./shepherd/stats.js";

const ALL_STATUSES: WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface StatsOpts {
  from?: string;
  to?: string;
  json?: boolean;
}

function formatStats(rows: readonly StatsRow[]): string {
  if (rows.length === 0) return "no merges in range\n";
  const lines = rows.map((r) => `${r.repo}  ${r.week}  merges ${r.merges}  slow(>60m) ${r.slowMerges}  slow hours ${r.slowHours}  outside Shepherd ${r.outsideMerges}`);
  return `${lines.join("\n")}\n`;
}

/** `titan-factory shepherd stats`: reads the ledger through a read-only connection, so a running serve is never disturbed. */
export function registerShepherdStats(shepherd: Command, io: CliIo, dbPath: () => string, setExit: (code: number) => void): void {
  shepherd
    .command("stats")
    .description("per repo and ISO week: PRs whose reviewer MERGE-to-merged wait exceeded 60 minutes, and merges made outside Shepherd")
    .option("--from <date>", "first day, YYYY-MM-DD (UTC)")
    .option("--to <date>", "last day, YYYY-MM-DD (UTC), inclusive")
    .option("--json", "print the rows as JSON")
    .action((opts: StatsOpts) => {
      const bad = [opts.from, opts.to].find((date) => date !== undefined && !DATE.test(date));
      if (bad !== undefined) return (io.stderr(`error: expected YYYY-MM-DD, got ${JSON.stringify(bad)}\n`), setExit(2));
      let db: ReturnType<typeof openDatabase>;
      try {
        db = openDatabase(dbPath(), { readonly: true });
      } catch (error) {
        return (io.stderr(`error: cannot read the store at ${dbPath()}: ${error instanceof Error ? error.message : String(error)}\n`), setExit(2));
      }
      try {
        const runs = new WorkflowRunStore(db).listByStatus(ALL_STATUSES).filter((run) => run.workflowName === SHEPHERD_WORKFLOW);
        const rows = shepherdStats(runs, { from: opts.from, to: opts.to });
        io.stdout(opts.json ? `${JSON.stringify(rows, null, 2)}\n` : formatStats(rows));
      } finally {
        db.close();
      }
    });
}
