import { memoryMigration, PlaybookStore, recall } from "@titan-design/memory";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";

export interface DrainOccurrence {
  templateId: string;
  sessionId: string;
  ts: string;
  maskedSignature: string;
}

interface ReplayWindow {
  /** Inclusive. */
  from: string;
  /** Exclusive. */
  to: string;
}

interface ReplayInput {
  occurrences: readonly DrainOccurrence[];
  /** Session title plus task titles per session id: what is known when the session opens, not the error. */
  openingQueries: ReadonlyMap<string, string>;
  window: ReplayWindow;
  k: number;
}

interface ClusterReplayRow {
  templateId: string;
  occurrences: number;
  laterOccurrences: number;
  servedBefore: number;
}

interface ReplayResult {
  clusters: number;
  laterOccurrences: number;
  servedBefore: number;
  servedRate: number;
  /** Share of in-window occurrences, over every template, that repeat an earlier one: the rate a playbook has to beat. */
  baselineRepeatRate: number;
  rows: ClusterReplayRow[];
}

const MIN_CLUSTER_OCCURRENCES = 3;

/**
 * Replays history against a playbook seeded from each recurring cluster's first
 * occurrence: would the bullet have surfaced, in the top k, when a later session
 * opened? One store holds every cluster's bullet, so top k is contested the way
 * it would be live, and events run in time order so a bullet only exists for
 * occurrences after its seed.
 */
export async function replayPlaybook(input: ReplayInput): Promise<ReplayResult> {
  const inWindow = firstPerSession(input.occurrences.filter((o) => o.ts >= input.window.from && o.ts < input.window.to).sort(byTime));
  const byTemplate = groupByTemplate(inWindow);
  const eligible = [...byTemplate].filter(([, list]) => list.length >= MIN_CLUSTER_OCCURRENCES);
  const rows = await replayClusters(eligible, input);
  const laterOccurrences = sum(rows.map((r) => r.laterOccurrences));
  const servedBefore = sum(rows.map((r) => r.servedBefore));
  const repeats = inWindow.length - byTemplate.size;
  return {
    clusters: rows.length,
    laterOccurrences,
    servedBefore,
    servedRate: laterOccurrences === 0 ? 0 : servedBefore / laterOccurrences,
    baselineRepeatRate: inWindow.length === 0 ? 0 : repeats / inWindow.length,
    rows,
  };
}

async function replayClusters(clusters: [string, DrainOccurrence[]][], input: ReplayInput): Promise<ClusterReplayRow[]> {
  const db = openDatabase(":memory:");
  try {
    runMigrations(db, [memoryMigration(1)]);
    let clock = new Date(0);
    const store = new PlaybookStore(db, { now: () => clock });
    const rows = new Map(clusters.map(([templateId, list]) => [templateId, { templateId, occurrences: list.length, laterOccurrences: 0, servedBefore: 0 }]));
    const seeds = new Set(clusters.map(([, list]) => list[0]));
    const events = clusters.flatMap(([, list]) => list).sort(byTime);
    for (const event of events) {
      clock = new Date(event.ts);
      const row = rows.get(event.templateId)!;
      if (seeds.has(event)) {
        store.add({ id: bulletId(event.templateId), content: event.maskedSignature });
        continue;
      }
      row.laterOccurrences += 1;
      if (await isServed(store, event, input)) row.servedBefore += 1;
    }
    return [...rows.values()];
  } finally {
    db.close();
  }
}

async function isServed(store: PlaybookStore, event: DrainOccurrence, input: ReplayInput): Promise<boolean> {
  const query = input.openingQueries.get(event.sessionId) ?? "";
  const result = await recall(store, query, { limit: input.k, now: new Date(event.ts) });
  return result.bullets.some((b) => b.id === bulletId(event.templateId));
}

function groupByTemplate(sorted: readonly DrainOccurrence[]): Map<string, DrainOccurrence[]> {
  const groups = new Map<string, DrainOccurrence[]>();
  for (const o of sorted) {
    const group = groups.get(o.templateId);
    if (group) group.push(o);
    else groups.set(o.templateId, [o]);
  }
  return groups;
}

/** A session that retries into the same error many times is one occurrence of it: only the first can precede a later session's opening. */
function firstPerSession(sorted: readonly DrainOccurrence[]): DrainOccurrence[] {
  const seen = new Set<string>();
  return sorted.filter((o) => {
    const key = JSON.stringify([o.templateId, o.sessionId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function bulletId(templateId: string): string {
  return `drain-${templateId}`;
}

function byTime(a: DrainOccurrence, b: DrainOccurrence): number {
  return a.ts.localeCompare(b.ts) || a.templateId.localeCompare(b.templateId) || a.sessionId.localeCompare(b.sessionId);
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
