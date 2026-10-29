import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PriorRouter, PriorRouting } from "./prior.js";
import { parseWorkflowTable, TABLE_VERSION, type TableRead } from "./table.js";

/** The `shape-v1.yml` this package ships, with `needsOwns` on the size rows. */
export const DEFAULT_WORKFLOW_TABLE = fileURLToPath(new URL(`../../workflow/${TABLE_VERSION}.yml`, import.meta.url));

export const workflowTablePath = (autonomyRoot: string): string =>
  path.join(autonomyRoot, "workflow", `${TABLE_VERSION}.yml`);

/** `<autonomyRoot>/workflow/shape-v1.yml`, linted; undefined when the file is absent. */
export function readWorkflowTable(autonomyRoot: string): TableRead | undefined {
  const file = workflowTablePath(autonomyRoot);
  if (!fs.existsSync(file)) return undefined;
  return parseWorkflowTable(fs.readFileSync(file, "utf8"));
}

/** The router for `mode`, or the one note saying why the dispatch routes as today; `off` touches no file. */
export function readPriorRouter(mode: PriorRouting, autonomyRoot: string): { router?: PriorRouter; note?: string } {
  if (mode === "off") return {};
  const read = readWorkflowTable(autonomyRoot);
  if (read === undefined)
    return { note: `prior routing ${mode}: no workflow table at ${workflowTablePath(autonomyRoot)}; routing as today` };
  if (read.table === undefined)
    return { note: `prior routing ${mode}: workflow table: ${read.problems.join("; ")}; routing as today` };
  return { router: { mode, table: read.table } };
}
