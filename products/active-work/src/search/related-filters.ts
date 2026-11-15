import type { ResolvedHit } from './resolve.js';

/**
 * Handoff archives restate session records, which have their own class, and
 * were served 15 times and opened 0 times in the week to 2026-09-23 (TP-331).
 * `search` still finds them; only the unasked-for related block drops them.
 */
const NOT_SERVED_BY_RELATED = /(^|\/)sources\/handoff-archive[^/]*\.md$/;

export function servedByRelated(hit: ResolvedHit): boolean {
  return hit.class !== 'sources' || hit.path === null || !NOT_SERVED_BY_RELATED.test(hit.path);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A task the query already names adds nothing the caller does not have, and
 * would spend one of the few slots. Same token bounds as `context.graph`, so
 * `AL-1` does not name `AL-12`.
 */
export function namesTask(text: string, hit: ResolvedHit): boolean {
  if (hit.class !== 'tasks' || !hit.ref.startsWith('task:')) return false;
  const id = hit.ref.slice('task:'.length);
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegex(id)}(?![A-Za-z0-9])`, 'i').test(text);
}

/** Headroom for named tasks the filter may remove, so the slot backfills. */
export function namedIdCount(text: string): number {
  return new Set(text.match(/(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*-\d+(?![A-Za-z0-9])/g)).size;
}
