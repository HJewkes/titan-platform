import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ActiveWork } from "./active-work.js";
import type { CoordinatorRoots } from "./config-surfaces/coordinator.js";
import { dayWindow, type DayWindow } from "./coord-day.js";
import { foldSpawns, readLifecycleRows, type SpawnFact } from "./coord-spawns.js";
import type { ShepherdSource } from "./shepherd.js";
import { mergedRunsInWindow, mergeTimes, type FinishedRow, type PrRef } from "./shipped.js";

/** What `coord.cards` reads besides the coordinator roots: Shepherd's finished runs, task titles, and agent-chat's event log. */
export interface CardsSource {
  shepherd: Pick<ShepherdSource, "list" | "timeline">;
  activeWork: ActiveWork;
  /** The broker's history holds about an hour of events, so a day of spawns is read from events.db. */
  eventsDbPath: string;
}

const prRef = z.object({ repo: z.string(), number: z.number().int(), task: z.string(), initiative: z.string(), url: z.string() });

const card = z.object({
  coordinator: z.string(),
  /** The charter seat whose seat file carries this coordinator's name; null for an ad-hoc coordinator session. */
  seat: z.string().nullable(),
  agentsRun: z.number().int(),
  liveNow: z.number().int(),
  /** Summed over the agents whose exit row reported a cost; null when none did. */
  costUsd: z.number().nullable(),
  prsMerged: z.array(prRef),
  tasks: z.array(z.object({ id: z.string(), title: z.string().optional() })),
});

export const cardsResult = z.object({
  date: z.string(),
  cards: z.array(card),
  /** Merged PRs no spawn row in reach accounts for, or that more than one coordinator could own; never guessed. */
  unattributed: z.array(prRef),
  gaps: z.array(z.string()),
});

type Card = z.infer<typeof card>;
type CardsResult = z.infer<typeof cardsResult>;

/** An agent spawned the day before can merge today, so attribution looks back further than the day's own spawns. */
const ATTRIBUTION_LOOKBACK_MS = 2 * 86_400_000;
export const EVENTS_DB_UNREADABLE = "agent-chat events.db: not readable, so no agent is counted and every PR is unattributed";

const sameRepo = (a: string | null, b: string): boolean => a === null || a.toLowerCase() === b.toLowerCase();

function onlySpawner(spawns: readonly SpawnFact[]): string | null {
  const spawners = new Set(spawns.map((spawn) => spawn.spawnedBy));
  return spawners.size === 1 ? [...spawners][0]! : null;
}

/** The branch names the run exactly; a task match counts only when one coordinator's implementers carried that task. */
function spawnerOf(row: FinishedRow, ref: PrRef, spawns: readonly SpawnFact[]): string | null {
  const inRepo = spawns.filter((spawn) => sameRepo(spawn.repo, row.repo));
  const byBranch = inRepo.filter((spawn) => spawn.branch === row.branch);
  if (byBranch.length > 0) return onlySpawner(byBranch);
  return onlySpawner(inRepo.filter((spawn) => spawn.implementer && spawn.task === ref.task));
}

async function seatNames(roots: CoordinatorRoots | undefined): Promise<Set<string>> {
  if (roots?.autonomyDir == null) return new Set();
  const names = await readdir(path.join(roots.autonomyDir, "seats")).catch(() => [] as string[]);
  return new Set(names.filter((name) => name.endsWith(".md")).map((name) => path.basename(name, ".md")));
}

function emptyCard(coordinator: string, seats: Set<string>): Card {
  return { coordinator, seat: seats.has(coordinator) ? coordinator : null, agentsRun: 0, liveNow: 0, costUsd: null, prsMerged: [], tasks: [] };
}

function addSpawn(target: Card, spawn: SpawnFact): void {
  target.agentsRun += 1;
  if (spawn.live) target.liveNow += 1;
  if (spawn.costUsd !== null) target.costUsd = (target.costUsd ?? 0) + spawn.costUsd;
  if (spawn.task !== null && spawn.implementer) target.tasks.push({ id: spawn.task });
}

interface Grouping {
  window: DayWindow;
  spawns: readonly SpawnFact[];
  runs: readonly { row: FinishedRow; ref: PrRef }[];
  seats: Set<string>;
}

/** One card per coordinator that spawned an agent in the window or owns a PR merged in it. */
function groupCards({ window, spawns, runs, seats }: Grouping): { cards: Card[]; unattributed: PrRef[] } {
  const cards = new Map<string, Card>();
  const cardOf = (name: string): Card => cards.get(name) ?? cards.set(name, emptyCard(name, seats)).get(name)!;
  for (const spawn of spawns) if (spawn.at >= window.from && spawn.at < window.to) addSpawn(cardOf(spawn.spawnedBy), spawn);
  const inReach = spawns.filter((spawn) => spawn.at < window.to);
  const unattributed: PrRef[] = [];
  for (const { row, ref } of runs) {
    const spawner = spawnerOf(row, ref, inReach);
    if (spawner === null) {
      unattributed.push(ref);
      continue;
    }
    cardOf(spawner).prsMerged.push(ref);
    cardOf(spawner).tasks.push({ id: ref.task });
  }
  const ordered = [...cards.values()].sort((a, b) => b.agentsRun - a.agentsRun || a.coordinator.localeCompare(b.coordinator));
  return { cards: ordered.map((entry) => ({ ...entry, tasks: uniqueTasks(entry.tasks) })), unattributed };
}

const uniqueTasks = (tasks: Card["tasks"]): Card["tasks"] => [...new Set(tasks.map((task) => task.id))].sort().map((id) => ({ id }));

/** Titles are enrichment: a failed task read leaves every card with its ids and adds a gap. */
async function withTitles(activeWork: ActiveWork, cards: Card[], gaps: string[]): Promise<Card[]> {
  if (cards.every((entry) => entry.tasks.length === 0)) return cards;
  const titles = await activeWork
    .read("task.list", { all_initiatives: true, status: "all" })
    .then(({ tasks }) => new Map(tasks.map((task) => [task.id, task.title])))
    .catch((err: unknown) => (gaps.push(`active-work task titles: ${err instanceof Error ? err.message : String(err)}`), null));
  if (titles === null) return cards;
  return cards.map((entry) => ({ ...entry, tasks: entry.tasks.map(({ id }) => ({ id, ...(titles.has(id) && { title: titles.get(id)! }) })) }));
}

interface CardsOptions {
  roots: CoordinatorRoots | undefined;
  dayStart: string;
  now: number;
  date?: string;
}

/** Local reads only: Shepherd's finished list, events.db, the seats dir and one active-work task list; no GitHub or model call. */
export async function readCards(source: CardsSource, { roots, dayStart, now, date }: CardsOptions): Promise<CardsResult> {
  const window = dayWindow(now, dayStart, date);
  const gaps: string[] = [];
  const rows = readLifecycleRows(source.eventsDbPath, window.from - ATTRIBUTION_LOOKBACK_MS);
  if (rows === null) gaps.push(EVENTS_DB_UNREADABLE);
  const [finished, seats] = await Promise.all([source.shepherd.list("finished"), seatNames(roots)]);
  const runs = mergedRunsInWindow(finished, window, await mergeTimes(source.shepherd, finished, window));
  const { cards, unattributed } = groupCards({ window, spawns: foldSpawns(rows ?? []), runs, seats });
  return { date: window.date, cards: await withTitles(source.activeWork, cards, gaps), unattributed, gaps };
}
