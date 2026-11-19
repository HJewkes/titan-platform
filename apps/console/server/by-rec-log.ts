/**
 * The console's by-rec files (TP-6765), beside its other state: the owner's policy file and the log of auto-by-rec rows.
 *
 * The policy file (`titan/auto-by-rec-policy@1`) is optional: absent, the sweeps run in shadow, the schema's default, so a
 * fresh console only logs what it would have done. A file that is present but does not parse turns the sweeps off rather
 * than falling back to a default, since its owner meant something by it. Each row is one `titan/auto-by-rec@1` line in
 * `auto-by-rec.jsonl`, appended and never rewritten; the log page reads it.
 */
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { byRecPolicySchema, byRecRowSchema, BY_REC_POLICY_SCHEMA, type ByRecPolicy, type ByRecRow } from "@titan-design/owner-queue";
import { exists, parseStateJson, readStateFile } from "./state-file.js";

export const BY_REC_POLICY_FILE = "auto-by-rec-policy.json";
export const BY_REC_ROWS_FILE = "auto-by-rec.jsonl";
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

interface PolicyRead {
  policy: ByRecPolicy;
  /** Set when the file was present but unusable, so the sweep ran with mode off. */
  problem?: string;
}

export async function readByRecPolicy(stateDir: string): Promise<PolicyRead> {
  const file = path.join(stateDir, BY_REC_POLICY_FILE);
  const parsed = parseStateJson(await readStateFile(file), byRecPolicySchema);
  if (parsed !== undefined) return { policy: parsed };
  const fallback = byRecPolicySchema.parse({ schema: BY_REC_POLICY_SCHEMA });
  if (!(await exists(file))) return { policy: fallback };
  return { policy: { ...fallback, mode: "off" }, problem: `${BY_REC_POLICY_FILE} is not a valid ${BY_REC_POLICY_SCHEMA} file; by-rec sweeps are off` };
}

/** Throws on a row that does not match the schema: a sweep must never log a row the log page would drop. */
export async function appendByRecRows(stateDir: string, rows: readonly ByRecRow[]): Promise<void> {
  if (rows.length === 0) return;
  const lines = rows.map((row) => `${JSON.stringify(byRecRowSchema.parse(row))}\n`).join("");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const handle = await open(path.join(stateDir, BY_REC_ROWS_FILE), APPEND_FLAGS, 0o600);
  try {
    await handle.writeFile(lines);
  } finally {
    await handle.close();
  }
}
