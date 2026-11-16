import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CONTRACT, type CodeReadCommandMap } from '@titan-design/code-read/query';
import { CLIENT_HEADER } from '@titan-design/daemon';
import { z } from 'zod';
import { utf8Bytes, type BriefBlock } from './brief-block.js';
import type { RelatedDegradation } from './related.js';

/**
 * The spawn brief's code section (TP-5453 P11b): one hop of imports around each named file.
 * Codewatch's loopback read API answers both directions from its snapshot. When it is not
 * answering, the named files' own imports are read from the checkout, so a brief still gets the
 * dependencies and only the importers go missing.
 */

const CODE_DEADLINE_MS = 800;
/** Leaves the rest of the section's time for reading the checkout when codewatch stays silent. */
const CODEWATCH_DEADLINE_MS = 500;
/** Codewatch's `CODE_REPORT_PORT`; a product reaches another product over loopback, never by import. */
const CODEWATCH_URL = 'http://127.0.0.1:7433';
const CODE_SHARE_BYTES = 800;
const CODE_LINES = 6;
const FILES_ASKED = CODE_LINES;
const HEADING = '## Code neighbours of the named files\n\n';
const SECTION_GAP = '\n\n';
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) => delay(ms, undefined, { signal });

/** Settles with `work`, or with `onTimeout()` once `ms` passes on the injected clock; either way `work` is aborted. */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  sleep: Sleep,
  onTimeout: () => T,
): Promise<T> {
  const controller = new AbortController();
  const timedOut = sleep(ms, controller.signal).then(onTimeout, onTimeout);
  try {
    return await Promise.race([work(controller.signal), timedOut]);
  } finally {
    controller.abort();
  }
}

export interface CodeDeps {
  fetch?: typeof fetch;
  codewatchUrl?: string;
  sleep?: Sleep;
  /** The checkout the named files are read from when codewatch is not answering; absent, no dependencies either. */
  repoRoot?: string;
}

export interface BriefCode {
  lines: string[];
  /** The file each line names, in line order. */
  refs: string[];
  degraded: RelatedDegradation[];
}

type Direction = 'imports' | 'imported by';
interface Neighbour {
  path: string;
  direction: Direction;
  named: string;
}
type NeighborsResult = CodeReadCommandMap['node.neighbors']['result'];

/** Checked, not cast: a stale codewatch on an older contract fails here and the brief falls back. */
const NeighborsEnvelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: CONTRACT['node.neighbors'].result }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

function line(neighbour: Neighbour): string {
  return `- ${neighbour.path} (${neighbour.direction}) ${neighbour.named}`;
}

async function askCodewatch(named: string, deps: CodeDeps, signal: AbortSignal): Promise<NeighborsResult> {
  const args: CodeReadCommandMap['node.neighbors']['args'] = { id: named, edge_kinds: ['imports'], limit: CODE_LINES };
  const response = await (deps.fetch ?? fetch)(`${deps.codewatchUrl ?? CODEWATCH_URL}/rpc/node.neighbors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'active-work-brief' },
    body: JSON.stringify(args),
    signal,
  });
  const envelope = NeighborsEnvelope.parse(await response.json());
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data;
}

/** A neighbour that imports the named file "imports" it; one the named file imports is "imported by" it. */
function fromSnapshot(named: string, result: NeighborsResult): Neighbour[] {
  const files = (edges: NeighborsResult['inbound']) => edges.filter((edge) => edge.node.kind === 'file');
  return [
    ...files(result.outbound).map((edge) => ({ path: edge.node.id, direction: 'imported by' as const, named })),
    ...files(result.inbound).map((edge) => ({ path: edge.node.id, direction: 'imports' as const, named })),
  ];
}

/**
 * The real path of `relative` when it names a file inside `repoRoot`, else null. Real paths on both
 * sides, so `..`, an absolute path outside the checkout and a symlink out of it are all refused.
 */
async function realFileIn(repoRoot: string, relative: string): Promise<string | null> {
  try {
    const [root, file] = await Promise.all([fs.realpath(repoRoot), fs.realpath(path.resolve(repoRoot, relative))]);
    const inside = file.startsWith(`${root}${path.sep}`);
    return inside && (await fs.stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** A `.js` specifier names the `.ts` source under NodeNext, so the source extensions are tried in its place. */
function candidates(target: string): string[] {
  const stem = target.replace(/\.(?:js|jsx|mjs)$/, '');
  const exact = stem === target ? [target] : [];
  return [...exact, ...SOURCE_EXTENSIONS.map((ext) => `${stem}${ext}`), `${stem}/index.ts`];
}

async function resolveImport(repoRoot: string, from: string, specifier: string): Promise<string | null> {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (target.startsWith('../')) return null;
  for (const candidate of candidates(target)) {
    if ((await realFileIn(repoRoot, candidate)) !== null) return candidate;
  }
  return null;
}

/** Relative imports only: a package import is not a file in this checkout. */
async function fromSource(named: string, repoRoot: string): Promise<Neighbour[]> {
  const real = await realFileIn(repoRoot, named);
  const source = real === null ? '' : await fs.readFile(real, 'utf8').catch(() => '');
  const specifiers = [...new Set(Array.from(source.matchAll(RELATIVE_IMPORT), (match) => match[1]))];
  const resolved = await Promise.all(specifiers.map((specifier) => resolveImport(repoRoot, named, specifier)));
  return resolved.flatMap((found) => (found === null ? [] : [{ path: found, direction: 'imported by' as const, named }]));
}

function noSnapshot(message: string): RelatedDegradation {
  return { source: 'code', reason: 'no-snapshot', message };
}

/** The snapshot's neighbours, or why codewatch gave none; a silent codewatch leaves time to read the checkout. */
function neighboursOf(named: string, deps: CodeDeps): Promise<Neighbour[] | string> {
  const ask = async (signal: AbortSignal): Promise<Neighbour[] | string> => {
    try {
      return fromSnapshot(named, await askCodewatch(named, deps, signal));
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const silent = (): string => `codewatch did not answer within ${CODEWATCH_DEADLINE_MS} ms`;
  return withDeadline(ask, CODEWATCH_DEADLINE_MS, deps.sleep ?? defaultSleep, silent);
}

/**
 * Codewatch's answer carries no repo key, so a snapshot of another repo can answer for a same-named
 * path. With the spawn's checkout known, only a named file and neighbours that exist there are kept.
 */
async function inSpawnRepo(named: string, found: Neighbour[], repoRoot: string | undefined): Promise<Neighbour[]> {
  if (repoRoot === undefined) return found;
  if ((await realFileIn(repoRoot, named)) === null) return [];
  const present = await Promise.all(found.map((entry) => realFileIn(repoRoot, entry.path)));
  return found.filter((_, i) => present[i] !== null);
}

async function gather(files: readonly string[], deps: CodeDeps): Promise<BriefCode> {
  const asked = files.slice(0, FILES_ASKED);
  const answers = await Promise.all(asked.map((named) => neighboursOf(named, deps)));
  const misses = answers.flatMap((answer) => (typeof answer === 'string' ? [answer] : []));
  const fallback = await Promise.all(
    asked.map((named, i) =>
      typeof answers[i] !== 'string' || deps.repoRoot === undefined ? [] : fromSource(named, deps.repoRoot),
    ),
  );
  const scoped = await Promise.all(
    answers.map((answer, i) => (typeof answer === 'string' ? [] : inSpawnRepo(asked[i] ?? '', answer, deps.repoRoot))),
  );
  const neighbours = answers.flatMap((answer, i) => (typeof answer === 'string' ? (fallback[i] ?? []) : (scoped[i] ?? [])));
  const named = new Set(files);
  const byLine = new Map(neighbours.filter((entry) => !named.has(entry.path)).map((entry) => [line(entry), entry.path]));
  const shown = [...byLine].slice(0, CODE_LINES);
  const lines = shown.map(([text]) => text);
  const refs = shown.map(([, file]) => file);
  return { lines, refs, degraded: misses.length === 0 ? [] : [noSnapshot(misses[0] ?? '')] };
}

/** Never rejects and never runs past {@link CODE_DEADLINE_MS} on the injected clock. */
export function briefCode(files: readonly string[], deps: CodeDeps = {}): Promise<BriefCode> {
  if (files.length === 0) return Promise.resolve({ lines: [], refs: [], degraded: [] });
  return withDeadline(
    () => gather(files, deps),
    CODE_DEADLINE_MS,
    deps.sleep ?? defaultSleep,
    () => ({ lines: [], refs: [], degraded: [{ source: 'code', reason: 'timeout', message: `over ${CODE_DEADLINE_MS} ms` }] }),
  );
}

/** The section goes after the workspace block, inside its own share and whatever budget is left. */
export function withCode(block: BriefBlock, code: BriefCode, budgetBytes: number): BriefBlock {
  const gap = block.text === '' ? '' : SECTION_GAP;
  const share = Math.min(CODE_SHARE_BYTES, budgetBytes - block.bytes - utf8Bytes(gap));
  const fitted: string[] = [];
  let used = utf8Bytes(HEADING);
  for (const entry of code.lines) {
    const cost = utf8Bytes(entry) + (fitted.length === 0 ? 0 : 1);
    if (used + cost > share) break;
    fitted.push(entry);
    used += cost;
  }
  if (fitted.length === 0) return block;
  const text = `${block.text}${gap}${HEADING}${fitted.join('\n')}`;
  const refs = code.refs.slice(0, fitted.length).map((ref) => ({ ref, source: 'code' as const }));
  return { ...block, text, refs: [...block.refs, ...refs], bytes: utf8Bytes(text) };
}
