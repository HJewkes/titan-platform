import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SlotEditSchema, type SlotEdit } from "../slot-edit.js";
import { sha256 } from "./artifacts.js";
import { readJson, writeJson } from "./run-dir.js";

const EDIT_ID = /^edit-[0-9a-f]{16}$/;

/**
 * One saved edit (`<dataDir>/edits/<editId>.json`): what it was drafted over, the script it stored, and the linked run
 * once that run starts. `stored` means no run was asked for; `started` means a run was launched, and `runId` is set
 * when it begins.
 */
export const EditLedgerSchema = z.object({
  schema: z.literal("explainer.edit-ledger/v1"),
  editId: z.string().regex(EDIT_ID),
  base: SlotEditSchema.shape.base,
  videoId: z.string(),
  scriptSha: z.string(),
  beats: SlotEditSchema.shape.beats,
  fromNote: z.string().optional(),
  createdAt: z.string(),
  status: z.enum(["stored", "started"]),
  runId: z.string().optional(),
});
export type EditLedger = z.infer<typeof EditLedgerSchema>;

const editsDir = (dataDir: string): string => path.join(dataDir, "edits");
export const ledgerFile = (dataDir: string, editId: string): string => path.join(editsDir(dataDir), `${editId}.json`);
export const editLogFile = (dataDir: string, editId: string): string => path.join(editsDir(dataDir), `${editId}.log`);

/** The same edit saved twice is one ledger row. */
export const editIdOf = (edit: SlotEdit): string => `edit-${sha256(JSON.stringify(edit)).slice(0, 16)}`;

export function readLedger(dataDir: string, editId: string): EditLedger {
  if (!EDIT_ID.test(editId)) throw new Error(`"${editId}" is not an edit id (edit-<16 hex>)`);
  const ledger = readJson(ledgerFile(dataDir, editId), EditLedgerSchema);
  if (!ledger) throw new Error(`no edit ${editId} in ${editsDir(dataDir)}`);
  return ledger;
}

export const writeLedger = (dataDir: string, ledger: EditLedger): void => writeJson(ledgerFile(dataDir, ledger.editId), ledger);

/** Called by the linked run as it starts, so the ledger names the run that carries the edit. */
export function linkEditRun(dataDir: string, editId: string, runId: string): void {
  writeLedger(dataDir, { ...readLedger(dataDir, editId), status: "started", runId });
}

/** Every ledger row, oldest first. */
export function listLedgers(dataDir: string): EditLedger[] {
  const dir = editsDir(dataDir);
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).filter((id) => EDIT_ID.test(id));
  return ids.map((id) => readLedger(dataDir, id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
