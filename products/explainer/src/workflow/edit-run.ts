import type { WorkflowRun } from "@titan-design/workflow";
import { readLedger } from "./edit-ledger.js";
import { CUSTOM_LAYERS } from "./layer-build.js";
import { stageRecords, type RunReport } from "./report.js";
import { planOf } from "./run-lineage.js";

/**
 * An edit run starts on the base the edit was drafted over and pins that base's custom layers, since a template-only
 * edit never needs a layer rebuilt (and a rebuild spends).
 */
export function editPins(dataDir: string, edit: string, base: WorkflowRun | undefined): Record<string, string> {
  const ledger = readLedger(dataDir, edit);
  if (base?.id !== ledger.base.runId) throw new Error(`edit ${edit} is over run ${ledger.base.runId}; pass --base ${ledger.base.runId}`);
  const layers = stageRecords(base).find((record) => record.stage === "resolve")?.outputs[CUSTOM_LAYERS] ?? planOf(base).artifacts[CUSTOM_LAYERS];
  return layers === undefined ? {} : { [CUSTOM_LAYERS]: layers };
}

export function editOf(dataDir: string, editId: string): RunReport["edit"] {
  const ledger = readLedger(dataDir, editId);
  return { editId, beats: Object.keys(ledger.beats).length, baseRunId: ledger.base.runId };
}
