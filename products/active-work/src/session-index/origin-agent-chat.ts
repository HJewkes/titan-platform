import { assignedTaskIds } from '@titan-design/session-read';
import type {
  ExternalEvent,
  OriginResolution,
  OriginResolver,
  ResolvedOrigin,
} from '@titan-design/session-graph';

import {
  agentChatHome,
  eventsDbSource,
  openBriefly,
  type FollowUp,
  type LifecycleEvent,
  type SpawnSource,
} from './origin-agent-chat-read.js';
import { loadKnownTaskIds } from './tasks.js';

/**
 * Who launched a session, read from agent-chat's own record (TP-274).
 *
 * A `claude -p` worker and a headless miner look the same from inside their
 * transcripts; only the launcher knows which one spawned which. The human
 * allowed reading `events.db` directly, read-only, as a temporary coupling
 * until agent-chat exports the same rows itself (decision Q2). Everything that
 * touches agent-chat's files sits behind `SpawnSource`, so that swap replaces
 * one implementation and none of the mapping.
 */

const ORIGIN_SYSTEM = 'agent-chat';
export const BRIEF_EXCERPT_CHARS = 400;

export type IsKnownTask = (taskId: string) => boolean;

/** Known task ids are read once per pass, so every origin in it links against the same store. */
export function agentChatOriginResolver(
  source: SpawnSource = eventsDbSource(agentChatHome(), openBriefly),
  taskRoot?: string,
): OriginResolver {
  return async (sessionIds) => {
    const known = await loadKnownTaskIds(taskRoot);
    return resolveFromSource(source, sessionIds, (id) => known.has(id));
  };
}

export function resolveFromSource(
  source: SpawnSource,
  sessionIds: readonly string[],
  isKnown: IsKnownTask,
): OriginResolution {
  const wanted = new Set(sessionIds);
  const index = buildIndex(source.events(), source.followUps());
  const origins: Record<string, ResolvedOrigin> = {};
  for (const spawn of index.spawns) {
    if (wanted.has(spawn.sessionId)) {
      origins[spawn.sessionId] = toOrigin(spawn, index, source, isKnown);
    }
  }
  const externalEvents = index.events
    .map((event) => toExternalEvent(event, index))
    .filter((event): event is ExternalEvent => event !== null && wanted.has(event.sessionId));
  return { origins, externalEvents };
}

interface Spawn {
  ts: number;
  actor: string;
  name: string;
  sessionId: string;
  agentId: string | null;
  meta: Record<string, unknown>;
}

interface SessionSighting {
  ts: number;
  sessionId: string;
}

interface SpawnIndex {
  spawns: Spawn[];
  spawnsByName: Map<string, Spawn[]>;
  sessionsByAgent: Map<string, SessionSighting[]>;
  followUpsByTarget: Map<string, FollowUp[]>;
  events: LifecycleEvent[];
}

function buildIndex(events: LifecycleEvent[], followUps: FollowUp[]): SpawnIndex {
  const attaches = events.filter((e) => e.kind === 'agent_attached' && e.ref);
  const spawns = events
    .filter((e) => e.kind === 'agent_spawned')
    .map((e) => toSpawn(e, attaches))
    .filter((spawn): spawn is Spawn => spawn !== null);
  return {
    spawns,
    spawnsByName: groupBy(spawns, (spawn) => spawn.name),
    sessionsByAgent: sessionSightings(spawns, events),
    followUpsByTarget: groupBy(followUps, (followUp) => followUp.target),
    events,
  };
}

/**
 * A spawn row names the child but not its agent id; the child's first attach
 * under that name does. Names are unique among live agents, so the first
 * attach at or after the spawn is the same agent.
 */
function toSpawn(event: LifecycleEvent, attaches: LifecycleEvent[]): Spawn | null {
  const name = text(event.meta.name) ?? event.target;
  const sessionId = text(event.meta.session_id);
  if (!name || !sessionId) return null;
  const attach = attaches.find((a) => a.actor === name && a.ts >= event.ts);
  return {
    ts: event.ts,
    actor: event.actor,
    name,
    sessionId,
    agentId: attach?.ref ?? null,
    meta: event.meta,
  };
}

function sessionSightings(
  spawns: Spawn[],
  events: LifecycleEvent[],
): Map<string, SessionSighting[]> {
  const sightings: [string, SessionSighting][] = spawns
    .filter((spawn) => spawn.agentId !== null)
    .map((spawn) => [spawn.agentId as string, { ts: spawn.ts, sessionId: spawn.sessionId }]);
  for (const event of events) {
    const sessionId = text(event.meta.session_id);
    if (event.kind !== 'agent_spawned' && event.ref && sessionId) {
      sightings.push([event.ref, { ts: event.ts, sessionId }]);
    }
  }
  const byAgent = new Map<string, SessionSighting[]>();
  for (const [agentId, sighting] of sightings) {
    byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), sighting]);
  }
  for (const list of byAgent.values()) list.sort((a, b) => a.ts - b.ts);
  return byAgent;
}

function toOrigin(
  spawn: Spawn,
  index: SpawnIndex,
  source: SpawnSource,
  isKnown: IsKnownTask,
): ResolvedOrigin {
  const { meta } = spawn;
  const plan = spawn.agentId ? source.plan(spawn.agentId) : null;
  // The full brief: the excerpt ends inside the orientation block, before the assignment.
  // A recorded briefing_chars (CC-171) marks where that block ends, so it wins over the
  // heading rules, which break whenever agent-chat renames a heading.
  const task = assignedTaskIds({
    agentName: spawn.name,
    brief: plan?.brief ?? '',
    briefingChars: integer(meta.briefing_chars) ?? undefined,
    isKnown,
  });
  return {
    originSystem: ORIGIN_SYSTEM,
    agentId: spawn.agentId,
    agentName: spawn.name,
    parentName: spawn.actor,
    parentSessionId: parentSessionId(spawn, index),
    profile: text(meta.profile),
    modelAlias: text(meta.model),
    surface: text(meta.surface),
    isolation: text(meta.isolation),
    depth: integer(meta.depth),
    originKind: text(meta.origin) ?? 'spawned',
    configDir: text(meta.config_dir),
    spawnCwd: text(meta.cwd),
    spawnedAt: new Date(spawn.ts).toISOString(),
    briefChars: plan ? plan.brief.length : null,
    briefExcerpt: plan ? plan.brief.slice(0, BRIEF_EXCERPT_CHARS) : null,
    briefPath: plan?.path ?? null,
    taskIds: task.taskIds,
    taskSource: task.source,
    experimentId: text(meta.experiment_id),
    experimentArm: text(meta.experiment_arm),
    predecessor: text(meta.predecessor),
    followupKinds: followupKinds(spawn, index),
    ...routeColumns(meta),
  };
}

/** The launcher writes each `route_*` key as a string; any other type is a malformed row and reads as absent. */
function routeColumns(meta: Record<string, unknown>): Partial<ResolvedOrigin> {
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;
  return {
    routeMode: str(meta.route_mode),
    routeSource: str(meta.route_source),
    routePrior: str(meta.route_prior),
    routeReason: str(meta.route_reason),
    routeRequested: str(meta.route_requested),
    routeWanted: str(meta.route_wanted),
    routeWorkflow: str(meta.route_workflow),
    routeTable: str(meta.route_table),
    routeFacts: str(meta.route_facts),
    routeCandidate: str(meta.route_candidate),
    routeCandidateWanted: str(meta.route_candidate_wanted),
  };
}

/**
 * Names are reused, so a follow-up counts toward the spawn that held the name
 * when it was sent: from this spawn until the next one under the same name.
 */
function followupKinds(spawn: Spawn, index: SpawnIndex): Record<string, number> | null {
  const nextSpawn = (index.spawnsByName.get(spawn.name) ?? []).find((s) => s.ts > spawn.ts);
  const end = nextSpawn?.ts ?? Number.POSITIVE_INFINITY;
  const counts: Record<string, number> = {};
  for (const followUp of index.followUpsByTarget.get(spawn.name) ?? []) {
    if (followUp.ts >= spawn.ts && followUp.ts < end) {
      counts[followUp.kind] = (counts[followUp.kind] ?? 0) + 1;
    }
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

/**
 * By the parent's agent id first: a coordinator that renamed itself after
 * adoption spawns under a name no spawn row carries. The name rule from the
 * design is the fallback for rows that predate `meta.parent`. A depth-0 row is
 * an adopted human session, often adopted under its own name again after a
 * restart, so the name rule would call its previous session its parent.
 */
function parentSessionId(spawn: Spawn, index: SpawnIndex): string | null {
  if (integer(spawn.meta.depth) === 0) return null;
  const parentId = text(spawn.meta.parent);
  const byAgent = parentId ? sessionAt(index.sessionsByAgent.get(parentId), spawn.ts) : null;
  if (byAgent && byAgent !== spawn.sessionId) return byAgent;
  const byName = (index.spawnsByName.get(spawn.actor) ?? []).filter(
    (candidate) => candidate.ts < spawn.ts && candidate.sessionId !== spawn.sessionId,
  );
  return byName.at(-1)?.sessionId ?? null;
}

function sessionAt(sightings: SessionSighting[] | undefined, ts: number): string | null {
  const before = (sightings ?? []).filter((sighting) => sighting.ts <= ts);
  return before.at(-1)?.sessionId ?? null;
}

function toExternalEvent(event: LifecycleEvent, index: SpawnIndex): ExternalEvent | null {
  const mapped = externalKind(event);
  if (!mapped) return null;
  const sessionId =
    text(event.meta.session_id) ??
    (event.ref ? sessionAt(index.sessionsByAgent.get(event.ref), event.ts) : null);
  if (!sessionId) return null;
  return {
    sessionId,
    ts: new Date(event.ts).toISOString(),
    kind: mapped.kind,
    detail: mapped.detail,
    originSystem: ORIGIN_SYSTEM,
  };
}

function externalKind(event: LifecycleEvent): { kind: string; detail: string | null } | null {
  const { meta } = event;
  switch (event.kind) {
    case 'agent_resumed': {
      const from = text(meta.from_surface);
      return from
        ? {
            kind: 'teleport',
            detail: `${from} to ${text(meta.surface) ?? '?'}`,
          }
        : null;
    }
    case 'agent_handoff':
      return { kind: 'handoff', detail: labelled('successor', meta.successor) };
    case 'agent_retired':
      return {
        kind: 'retired',
        detail: meta.reaped === 'true' ? 'reaped' : null,
      };
    case 'agent_exited':
      return { kind: 'exited', detail: labelled('code', meta.code) };
    default:
      return null;
  }
}

function labelled(label: string, value: unknown): string | null {
  const shown = text(value);
  return shown === null ? null : `${label} ${shown}`;
}

function text(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value !== '' ? value : null;
}

function integer(value: unknown): number | null {
  const parsed = Number(text(value) ?? Number.NaN);
  return Number.isInteger(parsed) ? parsed : null;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
