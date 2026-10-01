import { z } from "zod";
import type { AgentNameRow, WakeEventRow } from "./cost-report-queries.js";
import { roleFromProfile } from "./roles.js";
import { ACTION_CLASSES, type ActionClass } from "./turn-action.js";

export const WAKE_FROM_KINDS = ["seat", "agent", "broadcast", "broker", "none"] as const;
export type WakeFromKind = (typeof WAKE_FROM_KINDS)[number];

/** Report roles whose wakes are cut into episodes: a human coordinator and a spawned coordinator seat. */
export const DEFAULT_EPISODE_ROLES: readonly string[] = ["coordinator", "worker:coordinator"];

/** A wake whose requests only read, answer in text, or call tools no rule names changed nothing outside the session. */
export const DEFAULT_NO_ACTION_CLASSES: readonly ActionClass[] = ["read-investigate", "text-only", "other"];

/** agent-chat's own name on the notices it writes, such as the agent lifecycle notice. */
export const BROKER_SENDER = "agent-chat";
export const AGENT_LIFECYCLE = "agent_lifecycle";
const UNNAMED = "unnamed";

const count = z.number().int().nonnegative();
const costFields = { episodes: count, requests: count, costUsd: z.number(), noActionEpisodes: count, noActionCostUsd: z.number() };
const fromSchema = z.object({ key: z.enum(WAKE_FROM_KINDS), ...costFields });
const causeSchema = z.object({
  key: z.string(),
  ...costFields,
  midLoopEpisodes: count,
  requestsPerEpisode: z.number(),
  costPerEpisode: z.number(),
  byFrom: z.array(fromSchema),
});
const pairSchema = z.object({ from: z.string(), fromKind: z.enum(WAKE_FROM_KINDS), to: z.string(), ...costFields });

export const wakeEpisodesSchema = z.object({
  roles: z.array(z.string()),
  noActionClasses: z.array(z.enum(ACTION_CLASSES)),
  ...costFields,
  /** Requests in the window that follow no event in it: the work an earlier arrival started. */
  unattributed: z.object({ requests: count, costUsd: z.number() }),
  byCause: z.array(causeSchema),
  /** Sender by receiver; a seat is named, every other sender is its kind. */
  pairs: z.array(pairSchema),
});

export type WakeEpisodes = z.infer<typeof wakeEpisodesSchema>;
export type WakeCauseEpisodes = z.infer<typeof causeSchema>;
export type WakePair = z.infer<typeof pairSchema>;

/** One request as the episode view needs it. */
export interface EpisodeRequestRow {
  costUsd: number;
  action: ActionClass;
  eventKey: string | null;
}

export interface WakeEpisode {
  key: string;
  cause: string;
  midLoop: boolean;
  fromKind: WakeFromKind;
  from: string;
  to: string;
  requests: number;
  costUsd: number;
  noAction: boolean;
}

export interface EpisodeNames {
  seats: ReadonlySet<string>;
  /** Each receiving session's agent-chat name. */
  receivers: ReadonlyMap<string, string>;
}

/** A seat is a name some top-level session carries, or one a coordinator profile was spawned under. */
export function episodeNames(rows: readonly AgentNameRow[]): EpisodeNames {
  const isSeat = (row: AgentNameRow) => row.originKind !== "spawned" || roleFromProfile(row.profile) === "coordinator";
  return {
    seats: new Set(rows.filter(isSeat).map((row) => row.agentName)),
    receivers: new Map(rows.map((row) => [row.sessionId, row.agentName])),
  };
}

/** The lifecycle notice is session-read's `channel_system`; every other cause keeps its name. */
export function episodeCause(cause: string): string {
  return cause === "channel_system" ? AGENT_LIFECYCLE : cause;
}

export function fromKindOf(event: WakeEventRow, seats: ReadonlySet<string>): WakeFromKind {
  if (!event.cause.startsWith("channel_") || event.fromName === null) return "none";
  if (event.fromName === BROKER_SENDER) return "broker";
  if (event.broadcast) return "broadcast";
  return seats.has(event.fromName) ? "seat" : "agent";
}

/** Each event with the requests that followed it, flagged no-action when every request's class is listed. */
export function buildWakeEpisodes(
  events: readonly WakeEventRow[],
  requests: readonly EpisodeRequestRow[],
  names: EpisodeNames,
  noActionClasses: readonly ActionClass[],
): WakeEpisode[] {
  const byEvent = groupBy(requests, (request) => request.eventKey ?? "");
  return events.map((event) => {
    const members = byEvent.get(event.key) ?? [];
    const fromKind = fromKindOf(event, names.seats);
    return {
      key: event.key,
      cause: episodeCause(event.cause),
      midLoop: event.delivery === "mid_loop",
      fromKind,
      from: pairSender(fromKind, event.fromName, names.seats),
      to: names.receivers.get(event.sessionId) ?? UNNAMED,
      requests: members.length,
      costUsd: members.reduce((sum, row) => sum + row.costUsd, 0),
      noAction: members.every((row) => noActionClasses.includes(row.action)),
    };
  });
}

/** Spawned agents have one-off names, so they collapse to `agent`; a seat broadcasting keeps its name. */
function pairSender(kind: WakeFromKind, name: string | null, seats: ReadonlySet<string>): string {
  if (kind === "seat" || (kind === "broadcast" && name !== null && seats.has(name))) return name!;
  return kind === "broadcast" ? "agent" : kind;
}

export function summarizeWakeEpisodes(
  episodes: readonly WakeEpisode[],
  requests: readonly EpisodeRequestRow[],
  roles: readonly string[],
  noActionClasses: readonly ActionClass[],
): WakeEpisodes {
  const keys = new Set(episodes.map((episode) => episode.key));
  const unattributed = requests.filter((row) => row.eventKey === null || !keys.has(row.eventKey));
  return {
    roles: [...roles],
    noActionClasses: [...noActionClasses],
    ...costOf(episodes),
    unattributed: { requests: unattributed.length, costUsd: unattributed.reduce((sum, row) => sum + row.costUsd, 0) },
    byCause: causeBuckets(episodes),
    pairs: pairBuckets(episodes),
  };
}

function costOf(episodes: readonly WakeEpisode[]) {
  const noAction = episodes.filter((episode) => episode.noAction);
  const sum = (list: readonly WakeEpisode[], pick: (episode: WakeEpisode) => number) => list.reduce((total, episode) => total + pick(episode), 0);
  return {
    episodes: episodes.length,
    requests: sum(episodes, (episode) => episode.requests),
    costUsd: sum(episodes, (episode) => episode.costUsd),
    noActionEpisodes: noAction.length,
    noActionCostUsd: sum(noAction, (episode) => episode.costUsd),
  };
}

/** Most expensive first; ties by key so the report is stable. */
function causeBuckets(episodes: readonly WakeEpisode[]): WakeCauseEpisodes[] {
  return [...groupBy(episodes, (episode) => episode.cause)]
    .map(([key, members]) => {
      const cost = costOf(members);
      return {
        key,
        ...cost,
        midLoopEpisodes: members.filter((episode) => episode.midLoop).length,
        requestsPerEpisode: cost.requests / cost.episodes,
        costPerEpisode: cost.costUsd / cost.episodes,
        byFrom: [...groupBy(members, (episode) => episode.fromKind)].map(([kind, part]) => ({ key: kind as WakeFromKind, ...costOf(part) })).sort(byCostThenKey),
      };
    })
    .sort(byCostThenKey);
}

function pairBuckets(episodes: readonly WakeEpisode[]): WakePair[] {
  const sent = episodes.filter((episode) => episode.fromKind !== "none");
  return [...groupBy(sent, (episode) => JSON.stringify([episode.from, episode.fromKind, episode.to]))]
    .map(([key, members]) => {
      const [from, fromKind, to] = JSON.parse(key) as [string, WakeFromKind, string];
      return { from, fromKind, to, ...costOf(members) };
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function byCostThenKey(a: { key: string; costUsd: number }, b: { key: string; costUsd: number }): number {
  return b.costUsd - a.costUsd || a.key.localeCompare(b.key);
}
