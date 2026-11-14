import path from 'node:path';
import { SEARCH_CLASSES, type SearchClass } from './classes.js';
import type { RelatedDegradation, RelatedHit } from './related.js';

/**
 * The spawn brief's related-context block, rendered to a UTF-8 byte budget (TP-5453 P11a).
 *
 * The daemon renders the text rather than the caller, so the class list, the id cap and
 * the byte accounting have one owner and a planning class added here reaches every
 * spawn without the broker changing.
 */

export const BRIEF_DEFAULT_BYTES = 2600;
export const BRIEF_MAX_BYTES = 4000;
/** The task's done_when: a spawn brief carries three related ids or fewer. */
export const BRIEF_WORKSPACE_IDS = 3;
const WORKSPACE_SHARE_BYTES = 1200;
const DEGRADED_SHARE_BYTES = 100;
const TITLE_MAX = 80;
const READ_IF_MAX = 120;

/** Transcripts are the raw form of what notes distil; initiative briefs are already in the orientation. */
const NOT_BRIEFED = new Set(['transcripts', 'initiatives']);

/** Every registered workspace class a brief ranks, so a newly registered class is briefed by default. */
export function briefClasses(classes: readonly SearchClass[] = SEARCH_CLASSES): string[] {
  return classes.map((cls) => cls.name).filter((name) => !NOT_BRIEFED.has(name));
}

interface BriefRef {
  ref: string;
  source: 'workspace';
}

export interface BriefBlock {
  text: string;
  refs: BriefRef[];
  bytes: number;
}

interface BriefBlockInput {
  hits: RelatedHit[];
  degraded: RelatedDegradation[];
  initiative?: string;
  activeRoot: string;
  budgetBytes: number;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Cut by code point so a multibyte character is never split. */
function bounded(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function workspaceLine(hit: RelatedHit, input: BriefBlockInput): string {
  const foreign =
    input.initiative === undefined || hit.initiative === input.initiative || hit.initiative === null
      ? ''
      : `[from \`${hit.initiative}\`] `;
  const readIf = hit.readIf === undefined ? '' : ` (read if: ${bounded(hit.readIf, READ_IF_MAX)})`;
  const where = hit.path === null ? '' : ` ${path.join(input.activeRoot, hit.path)}`;
  return `- ${foreign}${hit.ref} "${bounded(hit.title ?? hit.ref, TITLE_MAX)}"${readIf}${where}`;
}

function heading(count: number): string {
  return `## Related to this assignment (${count}, ranked; open with Read)\n\n`;
}

/** The ranked prefix that fits the share; stops at the first overflow so the cut never reorders. */
function fitWorkspace(input: BriefBlockInput, share: number): { lines: string[]; hits: RelatedHit[] } {
  const lines: string[] = [];
  const hits: RelatedHit[] = [];
  let used = utf8Bytes(heading(BRIEF_WORKSPACE_IDS));
  for (const hit of input.hits.slice(0, BRIEF_WORKSPACE_IDS)) {
    const line = workspaceLine(hit, input);
    const cost = utf8Bytes(line) + 1;
    if (used + cost > share) break;
    lines.push(line);
    hits.push(hit);
    used += cost;
  }
  return { lines, hits };
}

function degradedNote(degraded: RelatedDegradation[], room: number): string {
  if (degraded.length === 0) return '';
  const sources = [...new Set(degraded.map((entry) => `${entry.source} ${entry.reason}`))].join(', ');
  const note = `\n\n_Partial: ${sources}._`;
  return utf8Bytes(note) <= Math.min(room, DEGRADED_SHARE_BYTES) ? note : '';
}

/** Empty text when nothing ranked: a caller shows no section rather than a bare heading. */
export function renderBriefBlock(input: BriefBlockInput): BriefBlock {
  const workspaceShare = Math.min(WORKSPACE_SHARE_BYTES, input.budgetBytes);
  const { lines, hits } = fitWorkspace(input, workspaceShare);
  if (lines.length === 0) return { text: '', refs: [], bytes: 0 };
  const body = `${heading(lines.length)}${lines.join('\n')}`;
  const text = body + degradedNote(input.degraded, input.budgetBytes - utf8Bytes(body));
  const refs = hits.map((hit) => ({ ref: hit.ref, source: 'workspace' as const }));
  return { text, refs, bytes: utf8Bytes(text) };
}
