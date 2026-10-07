import { RELATIONS, sessionRef, taskRef } from "@titan-design/session-read";
import { callResolver } from "./enrich-result.js";
import type { SessionGraph } from "./graph.js";

/**
 * Who started a session and why, as a launcher such as agent-chat recorded it.
 * A transcript cannot state this: a `claude -p` worker and a headless miner look
 * the same from inside. Every field but `originSystem` is optional.
 */
export interface ResolvedOrigin {
  originSystem: string;
  agentId?: string | null;
  agentName?: string | null;
  parentName?: string | null;
  parentSessionId?: string | null;
  profile?: string | null;
  modelAlias?: string | null;
  surface?: string | null;
  isolation?: string | null;
  depth?: number | null;
  /** `spawned`, `adopted`, `inherited` or `human`. */
  originKind?: string | null;
  configDir?: string | null;
  spawnCwd?: string | null;
  spawnedAt?: string | null;
  briefChars?: number | null;
  briefExcerpt?: string | null;
  briefPath?: string | null;
  launchArgs?: string | null;
  /**
   * Task ids the spawn record assigned, primary first; each projects a `ran` edge. Leave it
   * undefined only if the resolver does not look for tasks: a stored link then stands and a
   * row without one is offered again. A task-aware resolver sets it, empty when nothing links.
   */
  taskIds?: readonly string[] | null;
  /** How the ids were found. Stored as `none` when `taskIds` is given but empty. */
  taskSource?: TaskLinkSource | null;
}

/** Stored when a task-aware resolver found no id, so the row is not offered again. */
export const NO_TASK_LINK = "none";

export type TaskLinkSource = "name" | "name-over-brief" | "brief-anchor" | "brief-paragraph" | typeof NO_TASK_LINK;

/** A lifecycle event the launcher saw outside the transcript: `teleport`, `handoff`, `retired`, `exited`. */
export interface ExternalEvent {
  sessionId: string;
  ts: string;
  kind: string;
  detail?: string | null;
  /** Defaults to the session's resolved origin system. */
  originSystem?: string | null;
}

export interface OriginResolution {
  /** Keyed by session id. */
  origins: Record<string, ResolvedOrigin>;
  externalEvents?: readonly ExternalEvent[];
}

/**
 * Supplied by the caller, never by this package: session-graph is tier 2 and
 * must not learn where a launcher keeps its records. Called once per pass with
 * every session that has no origin row, a stale one, or a null `task_source`.
 * A task-aware resolver returns an entry for every requested session it examined,
 * with `taskIds` empty when nothing links; a session left out is offered again.
 */
export type OriginResolver = (sessionIds: readonly string[]) => PromiseLike<OriginResolution> | OriginResolution;

export interface OriginEnrichment {
  /** Session ids handed to the resolver. */
  requested: number;
  /** `session_origin` rows the resolver wrote. */
  applied: number;
  /** `session_external_event` rows the resolver wrote. */
  events: number;
  /** The resolver threw; origin rows stand as the last pass left them. */
  failed: boolean;
  /** Why it failed, for the caller to log. Absent unless `failed`. */
  error?: string;
}

export const NO_ORIGINS: OriginEnrichment = Object.freeze({ requested: 0, applied: 0, events: 0, failed: false });

/**
 * A session whose transcript grew after its origin was resolved may have been retired or handed off since.
 * A null `task_source` means no task-aware resolver has answered for the row yet.
 */
const SESSIONS_NEEDING_ORIGIN = `
  SELECT s.session_id FROM session s LEFT JOIN session_origin o ON o.session_id = s.session_id
  WHERE o.session_id IS NULL OR o.resolved_at < s.ended_at OR o.task_source IS NULL
  ORDER BY s.session_id`;

const ORIGIN_COLUMNS = [
  "origin_system", "agent_id", "agent_name", "parent_name", "parent_session_id", "profile", "model_alias", "surface", "isolation", "depth",
  "origin_kind", "config_dir", "spawn_cwd", "spawned_at", "brief_chars", "brief_excerpt", "brief_path", "launch_args", "resolved_at",
] as const;

/** A null `task_source` means the resolver did not look for tasks, so the stored link stands; `none` clears it. */
const TASK_LINK_UPDATE = `task_source = COALESCE(excluded.task_source, task_source),
    task_ids = CASE WHEN excluded.task_source IS NOT NULL THEN excluded.task_ids ELSE task_ids END`;

/** An update, not a replace, so a column this writer does not name keeps its value. */
const UPSERT_ORIGIN = `
  INSERT INTO session_origin (session_id, origin_system, agent_id, agent_name, parent_name, parent_session_id,
    profile, model_alias, surface, isolation, depth, origin_kind, config_dir, spawn_cwd, spawned_at,
    brief_chars, brief_excerpt, brief_path, launch_args, task_ids, task_source, resolved_at)
  VALUES (@sessionId, @originSystem, @agentId, @agentName, @parentName, @parentSessionId,
    @profile, @modelAlias, @surface, @isolation, @depth, @originKind, @configDir, @spawnCwd, @spawnedAt,
    @briefChars, @briefExcerpt, @briefPath, @launchArgs, @taskIds, @taskSource, @resolvedAt)
  ON CONFLICT (session_id) DO UPDATE SET ${ORIGIN_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ")},
    ${TASK_LINK_UPDATE}`;

const UPSERT_EVENT = `
  INSERT INTO session_external_event (session_id, ts, origin_system, kind, detail)
  VALUES (@sessionId, @ts, COALESCE(@originSystem, (SELECT origin_system FROM session_origin WHERE session_id = @sessionId), 'unknown'), @kind, @detail)
  ON CONFLICT (session_id, ts, kind) DO UPDATE SET origin_system = excluded.origin_system, detail = excluded.detail`;

/** Existing subagent queries then cover launcher-spawned workers unchanged; `reconcile` fills `ended_at` from the child session. */
const PROJECT_SUBAGENTS = `
  INSERT INTO subagent (agent_ref, session_id, child_session_id, agent_type, label, started_at)
  SELECT 'agent:' || origin_system || ':' || agent_id, parent_session_id, session_id, profile, agent_name, spawned_at
  FROM session_origin WHERE parent_session_id IS NOT NULL AND agent_id IS NOT NULL
  ON CONFLICT (agent_ref) DO UPDATE SET session_id = excluded.session_id, child_session_id = excluded.child_session_id,
    agent_type = excluded.agent_type, label = excluded.label, started_at = COALESCE(excluded.started_at, started_at)`;

export function sessionsNeedingOrigin(graph: SessionGraph): string[] {
  return (graph.db.prepare(SESSIONS_NEEDING_ORIGIN).all() as { session_id: string }[]).map((r) => r.session_id);
}

/**
 * Resolve origins for the sessions that lack a current one, then project every
 * stored origin into `spawned` edges and `subagent` rows. Projecting from the
 * table, not from this pass's answer, restores rows a parent transcript's purge
 * removed. A resolver that throws costs this pass its origins and nothing else.
 */
export async function resolveOrigins(graph: SessionGraph, resolver: OriginResolver | undefined): Promise<OriginEnrichment> {
  if (!resolver) return NO_ORIGINS;
  const sessionIds = sessionsNeedingOrigin(graph);
  const outcome = await callResolver(sessionIds.length, () => resolver(sessionIds));
  if (!outcome.ok) {
    projectOrigins(graph, []);
    return { ...outcome.failure, events: 0 };
  }
  const written = writeResolution(graph, outcome.value, new Date().toISOString());
  projectOrigins(graph, Object.keys(outcome.value.origins));
  return { requested: sessionIds.length, ...written, failed: false };
}

function writeResolution(graph: SessionGraph, resolution: OriginResolution, resolvedAt: string): { applied: number; events: number } {
  const upsertOrigin = graph.db.prepare(UPSERT_ORIGIN);
  const upsertEvent = graph.db.prepare(UPSERT_EVENT);
  return graph.db.transaction(() => {
    let applied = 0;
    for (const [sessionId, origin] of Object.entries(resolution.origins)) {
      applied += upsertOrigin.run(originRow(sessionId, origin, resolvedAt)).changes;
    }
    let events = 0;
    for (const e of resolution.externalEvents ?? []) {
      events += upsertEvent.run({ sessionId: e.sessionId, ts: e.ts, kind: e.kind, detail: e.detail ?? null, originSystem: e.originSystem ?? null }).changes;
    }
    return { applied, events };
  })();
}

function originRow(sessionId: string, o: ResolvedOrigin, resolvedAt: string): Record<string, string | number | null> {
  return {
    sessionId, originSystem: o.originSystem, resolvedAt,
    agentId: o.agentId ?? null, agentName: o.agentName ?? null, parentName: o.parentName ?? null, parentSessionId: o.parentSessionId ?? null,
    profile: o.profile ?? null, modelAlias: o.modelAlias ?? null, surface: o.surface ?? null, isolation: o.isolation ?? null,
    depth: o.depth ?? null, originKind: o.originKind ?? null, configDir: o.configDir ?? null, spawnCwd: o.spawnCwd ?? null,
    spawnedAt: o.spawnedAt ?? null, briefChars: o.briefChars ?? null, briefExcerpt: o.briefExcerpt ?? null,
    briefPath: o.briefPath ?? null, launchArgs: o.launchArgs ?? null,
    ...taskLinkColumns(o),
  };
}

/** `undefined` ids mean a resolver that predates task links; null or empty ids mean it looked and found none. */
function taskLinkColumns(o: ResolvedOrigin): { taskIds: string | null; taskSource: string | null } {
  if (o.taskIds === undefined) return { taskIds: null, taskSource: null };
  if (!o.taskIds?.length) return { taskIds: null, taskSource: NO_TASK_LINK };
  return { taskIds: JSON.stringify(o.taskIds), taskSource: o.taskSource ?? NO_TASK_LINK };
}

function projectOrigins(graph: SessionGraph, resolved: readonly string[]): void {
  const spawned = graph.db.prepare("SELECT session_id, parent_session_id, spawned_at, resolved_at FROM session_origin WHERE parent_session_id IS NOT NULL").all() as {
    session_id: string; parent_session_id: string; spawned_at: string | null; resolved_at: string;
  }[];
  graph.db.transaction(() => {
    graph.db.prepare(PROJECT_SUBAGENTS).run();
    for (const o of spawned) {
      graph.edges.assert({ sourceRef: sessionRef(o.parent_session_id), relation: RELATIONS.SPAWNED, targetRef: sessionRef(o.session_id), tValid: o.spawned_at ?? o.resolved_at });
    }
    projectTaskLinks(graph, resolved);
  })();
}

/** A launcher's name is the coordinator's own choice, so it outranks anything read from a brief. */
const LINK_CONFIDENCE: Record<string, number> = { name: 1, "name-over-brief": 1, "brief-anchor": 0.9, "brief-paragraph": 0.6 };
const LOWEST_CONFIDENCE = 0.6;

interface TaskLinkRow { session_id: string; task_ids: string | null; task_source: string | null; spawned_at: string | null; resolved_at: string }

/**
 * Assert `session ran task` for every id a spawn record assigned, with a task row so
 * the same pass's `enrichTasks` fills its initiative. Only edges this projection made
 * (`attrs.via = 'origin'`) are expired; a transcript's `ran` edge carries no `via`.
 * Only this pass's rows are read: task links change only when a row is re-resolved.
 */
function projectTaskLinks(graph: SessionGraph, resolved: readonly string[]): void {
  const insertTask = graph.db.prepare("INSERT OR IGNORE INTO task (task_ref, task_id) VALUES (?, ?)");
  const select = graph.db.prepare("SELECT session_id, task_ids, task_source, spawned_at, resolved_at FROM session_origin WHERE session_id = ?");
  for (const sessionId of resolved) {
    const o = select.get(sessionId) as TaskLinkRow | undefined;
    if (!o) continue;
    const taskIds: string[] = o.task_ids ? (JSON.parse(o.task_ids) as string[]) : [];
    const source = sessionRef(o.session_id);
    const attrs = { via: "origin", source: o.task_source };
    const confidence = LINK_CONFIDENCE[o.task_source ?? ""] ?? LOWEST_CONFIDENCE;
    for (const taskId of taskIds) {
      insertTask.run(taskRef(taskId), taskId);
      graph.edges.assert({ sourceRef: source, relation: RELATIONS.RAN, targetRef: taskRef(taskId), tValid: o.spawned_at ?? o.resolved_at, attrs, confidence });
    }
    expireStaleTaskLinks(graph, source, new Set(taskIds.map(taskRef)));
  }
}

function expireStaleTaskLinks(graph: SessionGraph, source: string, linked: ReadonlySet<string>): void {
  for (const edge of graph.edges.from(source)) {
    if (edge.relation === RELATIONS.RAN && edge.attrs?.via === "origin" && !linked.has(edge.targetRef)) {
      graph.edges.expire(source, RELATIONS.RAN, edge.targetRef);
    }
  }
}
