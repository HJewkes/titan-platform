import { readLocatorText } from '@titan-design/locator';
import path from 'node:path';
import { toAbsolute } from '../workspace-index/refs.js';
import type { RelatedHit } from './related.js';

const SPAN_TEXT_MAX_CHARS = 2000;
/** UTF-8 spends at most 4 bytes on a character, so this many bytes always cover the cap. */
const SPAN_READ_MAX_BYTES = SPAN_TEXT_MAX_CHARS * 4;

export function seeLine(hit: Pick<RelatedHit, 'ref' | 'title'>): string {
  return hit.title === null ? hit.ref : `${hit.ref} "${hit.title}"`;
}

/** The span's text, capped; null when the file will not read or the span is empty. Never throws. */
async function readSpan(
  file: string,
  byteOffset: number,
  byteLength: number,
): Promise<string | null> {
  try {
    const locator = [0, byteOffset, Math.min(byteLength, SPAN_READ_MAX_BYTES)] as const;
    const text = (await readLocatorText(file, locator)).slice(0, SPAN_TEXT_MAX_CHARS);
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Renderings cheapest first: see-line, plus excerpt, plus span text when the span reads. */
export async function hitTiers(hit: RelatedHit, activeRoot: string): Promise<string[]> {
  const base = seeLine(hit);
  const line = hit.readIf === undefined ? base : `${base} (read if: ${hit.readIf})`;
  const tiers = [line, hit.excerpt === null ? line : `${line}\n${hit.excerpt}`];
  if (hit.path === null || hit.byteOffset === null || hit.byteLength === null) return tiers;
  const file = path.isAbsolute(hit.path) ? hit.path : toAbsolute(activeRoot, hit.path);
  const span = await readSpan(file, hit.byteOffset, hit.byteLength);
  return span === null ? tiers : [...tiers, `${line}\n${span}`];
}
