import { dirname, join } from "node:path";
import type { Command } from "commander";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import type { Verbs } from "../cli-types.js";
import { EXIT } from "../exit-codes.js";
import { parseDuration } from "../cli-options.js";
import { parsePrRef } from "../registry.js";
import { isFactEntry } from "../registry/entry.js";
import { factoryRegistry } from "../registry/steps/index.js";
import { readLog } from "./shadow-diff/log.js";
import { factFamiliesOf, shadowGate, shadowReport } from "./shadow-diff/report.js";
import { explainFact } from "./why.js";

const GATE_WINDOW_MS = 48 * 3_600_000;
type MarkerIo = Pick<Verbs, "io" | "dbPath" | "setExit">;

/** The whole log is read, not only the window: the gate asks how long the shadow has been on, which a clipped read could not answer. */
function reportFor(db: Db, sinceMs: number) {
  const now = Date.now();
  return { now, report: shadowReport(readLog(db, { sinceIso: new Date(0).toISOString() }), { since: now - sinceMs, now }) };
}

function diffLines(report: ReturnType<typeof reportFor>["report"]): string[] {
  const lines = [`rows: ${report.header.rows}, first entry end: ${report.header.firstEntryEnd ?? "none"}`];
  for (const [family, counts] of Object.entries(report.counts)) {
    const classes = Object.entries(counts.classes).map(([name, n]) => `${name}=${n}`).join(" ") || "no rows";
    const causes = Object.entries(counts.causes).map(([name, n]) => `${name}=${n}`).join(" ");
    lines.push(`${family}: ${classes}${causes ? ` | causes ${causes}` : ""} | material-only ${counts.materialOnly}`);
  }
  lines.push(`blocking rows: ${report.blocking.length}`);
  return lines;
}

function withReadOnlyDb<T>(path: string, run: (db: Db) => T): T {
  const db = openDatabase(path, { readonly: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function registerShadowVerbs(markers: Command, { io, dbPath, setExit }: MarkerIo): void {
  markers
    .command("shadow-diff")
    .description("SHD-2 disagreement counts per family, class and cause: the input to F12 and D-M3-17")
    .option("--since <duration>", "window such as 48h or 30m", parseDuration, GATE_WINDOW_MS)
    .option("--json", "print the report as JSON")
    .action((options: { since: number; json?: boolean }) => {
      const { report } = withReadOnlyDb(dbPath(), (db) => reportFor(db, options.since));
      io.stdout(options.json ? `${JSON.stringify(report)}\n` : `${diffLines(report).join("\n")}\n`);
      setExit(EXIT.OK);
    });
  markers
    .command("shadow-gate")
    .description("SHD-2 exit gate: exit 1 when blocked. It only reads; D-M3-26 turns the shadow off")
    .option("--json", "print the gate result as JSON")
    .action((options: { json?: boolean }) => {
      const factFamilies = factFamiliesOf(factoryRegistry.entries.filter(isFactEntry));
      const result = withReadOnlyDb(dbPath(), (db) => {
        const { now, report } = reportFor(db, GATE_WINDOW_MS);
        return shadowGate(report, { windowMs: GATE_WINDOW_MS, now, factFamilies });
      });
      const text = [result.pass ? "pass" : "blocked", ...result.reasons.map((reason) => `  ${reason}`)].join("\n");
      io.stdout(options.json ? `${JSON.stringify(result)}\n` : `${text}\n`);
      setExit(result.pass ? EXIT.OK : EXIT.FAILURE);
    });
}

/** `markers why`: read-only. With no git or tree source here, diff and landed facts read as unpinnable (D-M2-08 folds this into `why`). */
export function registerMarkers(program: Command, verbs: MarkerIo): void {
  const { io, dbPath, setExit } = verbs;
  const markers = program.command("markers").description("The M1b marker shadow (off by default; the run record stays authoritative)");
  registerShadowVerbs(markers, verbs);
  markers
    .command("why <ref> <fact>")
    .description("Explain a fact's marker verdict for owner/repo#N: its inputs, drift, and newest rows")
    .action(async (ref: string, fact: string) => {
      const item = parsePrRef(ref);
      const path = dbPath();
      const db = openDatabase(path, { readonly: true });
      try {
        const blobs = { blobDir: join(dirname(path), "marker-blobs") };
        const lines = await explainFact({ registry: factoryRegistry, sources: { db }, now: new Date().toISOString(), blobs }, { item, fact });
        io.stdout(`${lines.join("\n")}\n`);
        setExit(EXIT.OK);
      } finally {
        db.close();
      }
    });
}
