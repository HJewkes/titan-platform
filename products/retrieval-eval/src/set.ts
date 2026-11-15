import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { formatPairs, parsePairs, type EvalPair } from "./pairs.js";
import type { CorpusSnapshot } from "./snapshot.js";

/**
 * A pinned pair set: the pairs a run scores, frozen next to a manifest that
 * names them by content hash, so two runs that report the same set id were
 * scored on byte-identical pairs.
 */

const PAIRS_FILE = "pairs.jsonl";
const MANIFEST_FILE = "manifest.json";

interface SetManifest {
  id: string;
  pairCounts: Record<string, number>;
  frozenAt: string;
  snapshot: CorpusSnapshot;
}

export interface SetStamp {
  id: string;
  pairs: number;
}

interface LoadedSet {
  pairs: EvalPair[];
  stamp: SetStamp;
}

const ManifestIdSchema = z.looseObject({ id: z.string() });

function hashPairs(jsonl: string): string {
  return createHash("sha256").update(jsonl).digest("hex").slice(0, 12);
}

/** First occurrence of an id wins; sorted so input order cannot change the hash. */
function normalize(pairs: EvalPair[]): EvalPair[] {
  const byId = new Map<string, EvalPair>();
  for (const pair of pairs) if (!byId.has(pair.id)) byId.set(pair.id, pair);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function countByArm(pairs: EvalPair[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const pair of pairs) counts[pair.arm] = (counts[pair.arm] ?? 0) + 1;
  return counts;
}

export function freezeSet(pairsJsonl: string, outDir: string, snapshot: CorpusSnapshot, now = new Date()): SetManifest {
  const pairs = normalize(parsePairs(pairsJsonl));
  const frozen = formatPairs(pairs);
  const manifest: SetManifest = {
    id: hashPairs(frozen),
    pairCounts: countByArm(pairs),
    frozenAt: now.toISOString(),
    snapshot,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, PAIRS_FILE), frozen);
  writeFileSync(path.join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export function isSetDir(target: string): boolean {
  return statSync(target, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** Refuses a directory whose pairs no longer hash to the id its manifest recorded. */
export function loadSet(dir: string): LoadedSet {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new Error(`${dir} is not a frozen set: no ${MANIFEST_FILE}`);
  const manifest = ManifestIdSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const jsonl = readFileSync(path.join(dir, PAIRS_FILE), "utf8");
  const actual = hashPairs(jsonl);
  if (actual !== manifest.id) {
    throw new Error(`${dir} pairs hash ${actual} does not match manifest id ${manifest.id}; the frozen set was edited`);
  }
  const pairs = parsePairs(jsonl);
  return { pairs, stamp: { id: manifest.id, pairs: pairs.length } };
}
