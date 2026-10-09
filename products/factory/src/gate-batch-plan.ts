import { isDeepStrictEqual } from "node:util";
import type { GateRecord } from "@titan-design/hitl";
import { landGate, stepOf } from "./coordinator-evidence.js";
import type { FactoryHost } from "./host.js";
import type { ProofItem } from "./presence-proof.js";

/** After-stage gates follow a merge into deploy, release or activation; those stay one per proof. */
const RELEASE_STEPS: ReadonlySet<string> = new Set(["after-stages"]);
const HARDWARE_STEP = /device|hardware/;
const RELEASE_TABLE = "shepherd-release/";

/**
 * Checks every item of a verified statement against its live gate record before anything is recorded or fired; the
 * first refusal names its item. A gate must exist, and a merge gate must ask about the item's PR. In a batch every
 * gate must be a merge gate pinned to one head, outside the `shepherd-release` table, answered `merge` at the item's
 * head: the statement's own rules see only step ids, and the release table is on the gate record.
 */
export function itemsRefusal(host: FactoryHost, items: readonly ProofItem[]): string | undefined {
  for (const [index, item] of items.entries()) {
    const refusal = itemRefusal(host, item, items.length > 1);
    if (refusal !== undefined) return `item ${index + 1}: ${refusal}`;
  }
  return undefined;
}

function itemRefusal(host: FactoryHost, item: ProofItem, inBatch: boolean): string | undefined {
  const gate = host.gates.get(item.gate);
  if (gate === undefined) return `no gate ${item.gate}`;
  const land = landGate(gate);
  if (land && (land.repo.toLowerCase() !== item.repo.toLowerCase() || land.pr !== item.pr)) return `${item.gate} asks about ${land.repo}#${land.pr}, not ${item.repo}#${item.pr}`;
  if (!inBatch) return undefined;
  const kind = batchRefusal(gate);
  if (kind !== undefined) return `${item.gate} is ${kind}; it stays one per proof`;
  if (!isDeepStrictEqual(item.payload, { decision: "merge", headSha: item.headSha })) return `${item.gate} is answered other than merge at ${item.headSha}; a batch only merges`;
  return undefined;
}

/** What kind of gate this is when it may not ride in a batch; undefined for a plain merge gate. */
function batchRefusal(gate: GateRecord): string | undefined {
  const step = stepOf(gate.id);
  if (HARDWARE_STEP.test(step)) return "a hardware gate";
  if (RELEASE_STEPS.has(step)) return "a release gate";
  const land = landGate(gate);
  if (land === undefined) return "not a merge gate at a pinned head";
  return land.rule.startsWith(RELEASE_TABLE) ? "a release gate" : undefined;
}
