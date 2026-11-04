/**
 * The platform open-loops ledger file (TP-4316): `loop import` and `loop tier`
 * are its only writers.
 *
 * Writes go through the yaml Document API rather than parse-and-stringify, so
 * the sweep's header comment, key order and flow maps survive, and a re-tier
 * leaves every other row byte-identical.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { NotFoundError, ValidationError } from '../errors.js';
import { TierSeedSchema, type Tier, type TierSeed } from '../schemas/loop-ledger.js';
import { atomicWrite, withFileLock } from '../utils/fs-atomic.js';
import { readGlobalConfig } from '../utils/global-config.js';
import { getLockPath } from '../utils/paths.js';
import { assertValidSlug } from '../utils/slug.js';

const LEDGER_DEFAULTS = {
  initiative: 'titan-platform',
  loops: 'sources/open-loops.yml',
  tree: 'sources/tech-tree.yml',
} as const;

const TIER_KEYS = ['tier', 'tier_rank', 'tier_set'] as const;
/** Matches the sweep's hand layout: no folding, `{a: 1}` not `{ a: 1 }`. */
const WRITE_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

export interface LedgerPaths {
  initiative: string;
  loopsPath: string;
  treePath: string;
}

function insideInitiative(initiativeDir: string, rel: string, key: string): string {
  const resolved = path.resolve(initiativeDir, rel);
  if (!resolved.startsWith(initiativeDir + path.sep)) {
    throw new ValidationError(`loops.ledger.${key} must stay inside the initiative: ${rel}`);
  }
  return resolved;
}

/** Paths from config.json's `loops.ledger`, defaulting to the titan-platform sources. */
export async function resolveLedgerPaths(
  activeRoot: string,
  configRoot?: string,
): Promise<LedgerPaths> {
  const configured = (await readGlobalConfig(configRoot)).loops?.ledger ?? {};
  const initiative = configured.initiative ?? LEDGER_DEFAULTS.initiative;
  assertValidSlug(initiative);
  const initiativeDir = path.join(activeRoot, initiative);
  return {
    initiative,
    loopsPath: insideInitiative(initiativeDir, configured.loops ?? LEDGER_DEFAULTS.loops, 'loops'),
    treePath: insideInitiative(initiativeDir, configured.tree ?? LEDGER_DEFAULTS.tree, 'tree'),
  };
}

function parseYamlDocument(text: string, label: string): Document {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new ValidationError(`Could not parse ${label}: ${doc.errors[0].message}`);
  }
  return doc;
}

/** The file's text and mtime, or null when it does not exist. */
export async function readOptionalFile(
  filePath: string,
): Promise<{ text: string; mtime: string } | null> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
    return { text, mtime: stat.mtime.toISOString() };
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function loopRows(doc: Document, label: string): YAMLSeq {
  const rows = doc.get('loops', true);
  if (!isSeq(rows)) throw new ValidationError(`${label} has no \`loops:\` list`);
  return rows;
}

function asRow(node: unknown): { id: string; map: YAMLMap } | null {
  if (!isMap(node)) return null;
  const id = node.get('id');
  return typeof id === 'string' && id.length > 0 ? { id, map: node } : null;
}

function rowIndex(rows: YAMLSeq): Map<string, YAMLMap> {
  const byId = new Map<string, YAMLMap>();
  for (const node of rows.items) {
    const row = asRow(node);
    if (row !== null) byId.set(row.id, row.map);
  }
  return byId;
}

function hasTierState(row: YAMLMap): boolean {
  return TIER_KEYS.some((key) => row.has(key));
}

function writeTier(doc: Document, row: YAMLMap, tier: Tier | null, rank: number | null, set: object) {
  if (tier === null) {
    row.delete('tier');
    row.delete('tier_rank');
  } else {
    row.set('tier', tier);
    row.set('tier_rank', rank);
  }
  row.set('tier_set', doc.createNode(set, { flow: true }));
}

async function writeDocument(filePath: string, doc: Document): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWrite(filePath, doc.toString(WRITE_OPTIONS));
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

interface ImportInput {
  snapshotText: string;
  treeText?: string;
  seed?: TierSeed;
  now: Date;
}

interface ImportResult {
  ledger: string;
  tree: string | null;
  added: number;
  updated: number;
  seeded: number;
  warnings: string[];
}

/** A sweep owns every field but the tier ones, which belong to whoever set them. */
function upsertRow(existing: YAMLMap, incoming: YAMLMap): void {
  const keepTier = hasTierState(existing);
  for (const pair of incoming.items) {
    const key = String(isScalar(pair.key) ? pair.key.value : pair.key);
    if (keepTier && (TIER_KEYS as readonly string[]).includes(key)) continue;
    existing.set(key, pair.value);
  }
}

function mergeSnapshot(ledger: Document, snapshot: Document, result: ImportResult): void {
  const rows = loopRows(ledger, 'the ledger');
  const byId = rowIndex(rows);
  for (const [index, node] of loopRows(snapshot, 'the snapshot').items.entries()) {
    const row = asRow(node);
    if (row === null) {
      result.warnings.push(`Skipped snapshot row ${index + 1}: it has no id`);
      continue;
    }
    const existing = byId.get(row.id);
    if (existing === undefined) {
      rows.add(row.map);
      byId.set(row.id, row.map);
      result.added += 1;
    } else {
      upsertRow(existing, row.map);
      result.updated += 1;
    }
  }
}

const SEED_TIERS = [
  ['S', 'S'],
  ['A', 'A'],
  ['B', 'B'],
  ['C', 'C'],
  ['Parked', 'parked'],
  ['parked', 'parked'],
] as const;

function seedEntries(seed: TierSeed): Array<[string, Tier, number]> {
  return SEED_TIERS.flatMap(([key, tier]) =>
    (seed[key] ?? []).map((id, i): [string, Tier, number] => [id, tier, i + 1]),
  );
}

/** Seeds only rows nobody has tiered, so a re-import with the same seed is a no-op. */
function applySeed(doc: Document, seed: TierSeed, now: Date, result: ImportResult): void {
  const byId = rowIndex(loopRows(doc, 'the ledger'));
  const set = { at: now.toISOString(), by: 'proposal' };
  for (const [id, tier, rank] of seedEntries(seed)) {
    const row = byId.get(id);
    if (row === undefined) {
      result.warnings.push(`Tier seed names ${id}, which is not in the ledger`);
    } else if (!hasTierState(row)) {
      writeTier(doc, row, tier, rank, set);
      result.seeded += 1;
    }
  }
}

function emptyResult(paths: LedgerPaths): ImportResult {
  return { ledger: paths.loopsPath, tree: null, added: 0, updated: 0, seeded: 0, warnings: [] };
}

async function importTree(paths: LedgerPaths, treeText: string): Promise<void> {
  const tree = parseYamlDocument(treeText, 'the tree');
  if (!isSeq(tree.get('nodes', true))) throw new ValidationError('The tree has no `nodes:` list');
  await writeDocument(paths.treePath, tree);
}

export async function importLedger(paths: LedgerPaths, input: ImportInput): Promise<ImportResult> {
  const snapshot = parseYamlDocument(input.snapshotText, 'the snapshot');
  loopRows(snapshot, 'the snapshot');
  return withFileLock(getLockPath(paths.initiative), async () => {
    const result = emptyResult(paths);
    const current = await readOptionalFile(paths.loopsPath);
    const ledger = parseYamlDocument(current?.text ?? input.snapshotText, paths.loopsPath);
    // A first import starts from the snapshot's own document, so its header comment carries over.
    if (current === null) loopRows(ledger, 'the snapshot').items = [];
    mergeSnapshot(ledger, snapshot, result);
    if (input.seed !== undefined) {
      applySeed(ledger, TierSeedSchema.parse(input.seed), input.now, result);
    }
    await writeDocument(paths.loopsPath, ledger);
    if (input.treeText !== undefined) {
      await importTree(paths, input.treeText);
      result.tree = paths.treePath;
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// tier
// ---------------------------------------------------------------------------

interface RankedRow {
  id: string;
  tier: string | null;
  rank: number | null;
}

function byRank(a: RankedRow, b: RankedRow): number {
  return (a.rank ?? Infinity) - (b.rank ?? Infinity);
}

/**
 * The rank that puts `targetId` before `before` in `tier`, or last.
 *
 * Inserting between two ranks takes their midpoint, so no other row's rank
 * changes; a renumber would rewrite rows the owner did not move.
 */
function rankFor(rows: RankedRow[], targetId: string, tier: string, before?: string): number {
  const peers = rows.filter((row) => row.id !== targetId && row.tier === tier).sort(byRank);
  const last = Math.max(0, ...peers.map((row) => row.rank ?? 0)) + 1;
  if (before === undefined) return last;
  const next = peers.find((row) => row.id === before);
  if (next === undefined) throw new ValidationError(`--before ${before} is not a loop in tier ${tier}`);
  if (next.rank === null) return last;
  const at = peers.indexOf(next);
  const prev = at > 0 ? peers[at - 1].rank : null;
  return prev === null ? next.rank - 1 : (prev + next.rank) / 2;
}

function rankedRows(rows: YAMLSeq): RankedRow[] {
  return rows.items.flatMap((node) => {
    const row = asRow(node);
    if (row === null) return [];
    const tier = row.map.get('tier');
    const rank = row.map.get('tier_rank');
    return [
      {
        id: row.id,
        tier: typeof tier === 'string' ? tier : null,
        rank: typeof rank === 'number' ? rank : null,
      },
    ];
  });
}

interface TierInput {
  id: string;
  tier: Tier | null;
  before?: string;
  now: Date;
}

export interface TierResult {
  id: string;
  tier: Tier | null;
  tier_rank: number | null;
  tier_set: { at: string; by: 'owner' };
}

async function loadLedgerForWrite(paths: LedgerPaths): Promise<Document> {
  const current = await readOptionalFile(paths.loopsPath);
  if (current === null) {
    throw new NotFoundError(`No ledger at ${paths.loopsPath}; run \`active-work loop import\` first`);
  }
  return parseYamlDocument(current.text, paths.loopsPath);
}

export async function setLoopTier(paths: LedgerPaths, input: TierInput): Promise<TierResult> {
  return withFileLock(getLockPath(paths.initiative), async () => {
    const doc = await loadLedgerForWrite(paths);
    const rows = loopRows(doc, paths.loopsPath);
    const row = rowIndex(rows).get(input.id);
    if (row === undefined) throw new NotFoundError(`No ledger loop has id ${input.id}`);
    const rank =
      input.tier === null ? null : rankFor(rankedRows(rows), input.id, input.tier, input.before);
    const set = { at: input.now.toISOString(), by: 'owner' as const };
    writeTier(doc, row, input.tier, rank, set);
    await writeDocument(paths.loopsPath, doc);
    return { id: input.id, tier: input.tier, tier_rank: rank, tier_set: set };
  });
}
