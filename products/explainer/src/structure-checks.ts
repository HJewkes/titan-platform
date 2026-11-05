import type { DoctrineVocabulary } from "./doctrine-schema.js";
import type { NarrativeStructure } from "./structure-schema.js";

export const STRUCTURE_ISSUE_CODES = ["unknown-vocabulary", "missing-structure", "unknown-signal", "share-sum", "runtime-order", "duplicate-block"] as const;

export type StructureIssueCode = (typeof STRUCTURE_ISSUE_CODES)[number];

export interface StructureIssue {
  code: StructureIssueCode;
  structure: string;
  message: string;
}

/** Airtime shares are rounded to hundredths, so their sum may miss 1 by this much. */
const SHARE_TOLERANCE = 0.005;

type StructureCheck = (structure: NarrativeStructure, vocabulary: DoctrineVocabulary) => StructureIssue[];

const issue = (code: StructureIssueCode, structure: string, message: string): StructureIssue => ({ code, structure, message });

const named: StructureCheck = ({ id }, vocabulary) =>
  vocabulary.structures.includes(id) ? [] : [issue("unknown-vocabulary", id, `structure ${id} is not in vocabulary.yaml`)];

function signals({ id, fit }: NarrativeStructure, vocabulary: DoctrineVocabulary): StructureIssue[] {
  const used = [...new Set([...fit.all, ...fit.any, ...fit.none])];
  return used.filter((signal) => !vocabulary.signals.includes(signal)).map((signal) => issue("unknown-signal", id, `signal ${signal} is not in vocabulary.yaml`));
}

function shares({ id, blocks }: NarrativeStructure): StructureIssue[] {
  const sum = blocks.reduce((total, block) => total + block.share, 0);
  return Math.abs(sum - 1) <= SHARE_TOLERANCE ? [] : [issue("share-sum", id, `block shares sum to ${sum.toFixed(2)}, not 1`)];
}

function runtime({ id, fit }: NarrativeStructure): StructureIssue[] {
  const { minRuntimeS, maxRuntimeS } = fit;
  return minRuntimeS !== undefined && maxRuntimeS !== undefined && minRuntimeS > maxRuntimeS
    ? [issue("runtime-order", id, "fit needs minRuntimeS <= maxRuntimeS")]
    : [];
}

function uniqueBlocks({ id, blocks }: NarrativeStructure): StructureIssue[] {
  const ids = blocks.map((block) => block.id);
  return [...new Set(ids.filter((block, i) => ids.indexOf(block) !== i))].map((block) => issue("duplicate-block", id, `block ${block} appears more than once`));
}

const STRUCTURE_CHECKS: StructureCheck[] = [named, signals, shares, runtime, uniqueBlocks];

/**
 * Every refinement over the loaded structures against the vocabulary: each structure is named
 * there, each named structure has a file, fit predicates read known signals, and shares sum to 1.
 */
export function checkStructures(structures: ReadonlyMap<string, NarrativeStructure>, vocabulary: DoctrineVocabulary): StructureIssue[] {
  const missing = vocabulary.structures.filter((id) => !structures.has(id)).map((id) => issue("missing-structure", id, `vocabulary.yaml names ${id}, which has no structures/${id}.yaml`));
  return [...missing, ...[...structures.values()].flatMap((structure) => STRUCTURE_CHECKS.flatMap((check) => check(structure, vocabulary)))];
}
