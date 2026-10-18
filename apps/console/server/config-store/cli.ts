/**
 * `titan-console config import <tree> [--limits <file>]` writes rev 0 from an autonomy tree and
 * materializes it; `titan-console config compare-tree` prints the compare-tree diff. Import is the
 * owner's one-time shadow step: it refuses a log that already has a revision, so it can never
 * replace or extend the history a later owner edit wrote.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { revisionSha } from "@titan-design/coordinator";
import { compareTree, type ConfigStoreSource } from "./compare.js";
import { importTree, limitsSchema, type Limits } from "./import.js";
import { appendRevision, readRevisionLog, revisionLogPath } from "./log.js";
import { materializeDocument } from "./materialize.js";

type ConfigArgs = { verb: "import"; tree: string; limits: string | null } | { verb: "compare-tree" };

export const CONFIG_USAGE = `       titan-console config import <autonomy-tree> [--limits <limits.json>]
                                        write coordinator rev 0 from the tree and materialize it;
                                        --limits is read only when the charter has no pools block
       titan-console config compare-tree
                                        print the log head against the tree as JSON`;

/** Null when argv is not a `config` verb. */
export function configArgs(argv: readonly string[]): ConfigArgs | null {
  if (argv[0] !== "config") return null;
  if (argv[1] === "compare-tree" && argv.length === 2) return { verb: "compare-tree" };
  if (argv[1] !== "import" || argv[2] === undefined || argv[2].startsWith("-")) return null;
  if (argv.length === 3) return { verb: "import", tree: argv[2], limits: null };
  if (argv.length === 5 && argv[3] === "--limits" && argv[4] !== undefined) return { verb: "import", tree: argv[2], limits: argv[4] };
  return null;
}

async function readLimits(file: string | null): Promise<Limits | undefined> {
  return file === null ? undefined : limitsSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/** Returns the lines to print; throws with the refusal. */
export async function importRevisionZero(source: ConfigStoreSource, tree: string, limitsFile: string | null, at: Date = new Date()): Promise<string[]> {
  const logFile = revisionLogPath(source.stateDir);
  const log = await readRevisionLog(logFile);
  if (log.state !== "empty") throw new Error(`${logFile} already has revisions (${log.state}); an import writes rev 0 only`);
  const imported = await importTree(path.resolve(tree), { ...(limitsFile === null ? {} : { limits: await readLimits(limitsFile) }) });
  if (!imported.ok) throw new Error(imported.errors.map((error) => `${error.file}: ${error.path}: ${error.message}`).join("\n"));
  const revision = await appendRevision(logFile, {
    at: at.toISOString(),
    by: { class: "import", id: "titan-console config import" },
    ...(imported.notes.length === 0 ? {} : { notes: imported.notes }),
    document: imported.document,
  });
  const { sha } = await materializeDocument(source.coordinatorFile, imported.document);
  return [
    `rev 0 ${revisionSha(revision)} written to ${logFile} (${Object.keys(imported.document.seats).length} seats, ${imported.notes.length} notes, limits from the ${imported.limitsFrom})`,
    `materialized ${source.coordinatorFile} (document sha ${sha})`,
  ];
}

export async function configCli(source: ConfigStoreSource, args: ConfigArgs): Promise<void> {
  try {
    if (args.verb === "compare-tree") console.log(JSON.stringify(await compareTree(source), null, 2));
    else for (const line of await importRevisionZero(source, args.tree, args.limits)) console.log(line);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
