import path from "node:path";
import type { TranscriptHead, ToolUse } from "../corpus/transcripts.js";
import { readHead, streamToolUses, transcriptId } from "../corpus/transcripts.js";
import type { EvalPair, LinkMethod } from "../pairs.js";
import { dedupeLabels, labelledPathOf, normaliseLabel } from "./labels.js";

/**
 * The spawn arm: what a deterministic RAG step at spawn time would have to beat.
 *
 * The query is the brief a coordinator wrote. The labels are every file the
 * spawned agent then opened — which is exactly the set a retriever could have
 * put in front of it and did not.
 */

export interface Spawn {
  name: string;
  brief: string;
  briefing?: string;
  /** Where the spawned agent will run, from the tool input. */
  cwd?: string;
  /** Where the requesting session was running, from the transcript line. */
  requesterCwd?: string;
  parentTranscript: string;
  timestamp?: string;
}

const SPAWN_TOOL_SUFFIX = "agent_spawn";

/** agent-chat's sentinel for "work the initiative out from the directories". */
const AUTO_BRIEFING = "auto";

/**
 * Which initiative the spawn was briefed from, mirroring agent-chat's
 * `resolveBriefing`.
 *
 * An explicit slug wins. `auto` takes the requester's cwd and then the target's,
 * in that order, and reduces each to the first path segment under the active
 * root — which is all `slugForPath` does. The requester's cwd is not in the tool
 * input but the transcript line carries it, which is what makes this the same
 * answer agent-chat computed rather than a subset of it.
 */
export function briefingSlug(spawn: Spawn, activeRoot: string): string | undefined {
  if (spawn.briefing !== undefined && spawn.briefing !== AUTO_BRIEFING) return spawn.briefing;
  return slugForPath(spawn.requesterCwd, activeRoot) ?? slugForPath(spawn.cwd, activeRoot);
}

function slugForPath(dir: string | undefined, activeRoot: string): string | undefined {
  if (dir === undefined) return undefined;
  const relative = path.relative(activeRoot, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) return undefined;
  return relative.split(path.sep)[0];
}

export async function collectSpawns(files: string[]): Promise<Spawn[]> {
  const spawns: Spawn[] = [];
  for (const file of files) {
    for await (const tool of streamToolUses(file)) {
      if (!tool.name.endsWith(SPAWN_TOOL_SUFFIX)) continue;
      const spawn = spawnOf(tool, file);
      if (spawn) spawns.push(spawn);
    }
  }
  return spawns;
}

function spawnOf(tool: ToolUse, parentTranscript: string): Spawn | undefined {
  const { name, brief, briefing, cwd } = tool.input;
  if (typeof name !== "string" || typeof brief !== "string") return undefined;
  return {
    name,
    brief,
    ...(typeof briefing === "string" ? { briefing } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(tool.cwd ? { requesterCwd: tool.cwd } : {}),
    parentTranscript,
    ...(tool.timestamp ? { timestamp: tool.timestamp } : {}),
  };
}

/**
 * Where in the brief to cut the probe, and how long.
 *
 * Not the head: a brief's opening is boilerplate a coordinator reuses across
 * spawns, so a leading probe matches every sibling agent at once. Thirty
 * percent in is past the preamble and into the scope, which is what makes one
 * spawn distinguishable from the next.
 */
const PROBE_OFFSET = 0.3;
const PROBE_LENGTH = 120;
/** Below this a probe is too generic to trust, so the spawn is reported unlinked instead. */
const MIN_PROBE_LENGTH = 40;

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function briefProbe(brief: string): string | undefined {
  const flat = collapseWhitespace(brief);
  const start = Math.floor(flat.length * PROBE_OFFSET);
  const probe = flat.slice(start, start + PROBE_LENGTH);
  return probe.length >= MIN_PROBE_LENGTH ? probe : undefined;
}

export interface Link {
  transcript: string;
  method: LinkMethod;
}

/**
 * Find the transcript the brief was delivered into.
 *
 * The `subagent` table is the documented route and is empty on this machine
 * (0 rows), so the brief text itself is the join key: a spawned agent receives
 * the brief verbatim as its first user turn. When one brief was spawned more
 * than once, the earliest child that starts at or after the spawn breaks the
 * tie — a re-spawn is sequential, so "next one after" is unambiguous.
 */
export function linkSpawn(spawn: Spawn, heads: TranscriptHead[]): Link | undefined {
  const probe = briefProbe(spawn.brief);
  if (probe === undefined) return undefined;
  const matches = heads.filter(
    (head) => head.file !== spawn.parentTranscript && collapseWhitespace(head.firstUserText).includes(probe),
  );
  if (matches.length === 1) return { transcript: matches[0]!.file, method: "brief-text" };
  if (matches.length === 0) return undefined;
  const after = matches
    .filter((head) => head.startedAt !== undefined && spawn.timestamp !== undefined && head.startedAt >= spawn.timestamp)
    .sort((a, b) => a.startedAt!.localeCompare(b.startedAt!));
  return after.length > 0 ? { transcript: after[0]!.file, method: "brief-text+timestamp" } : undefined;
}

/** Every file the child opened, in first-touch order. */
export async function labelsFrom(transcript: string, activeRoot: string) {
  const labels = [];
  for await (const tool of streamToolUses(transcript)) {
    const absolute = labelledPathOf(tool);
    if (absolute) labels.push(normaliseLabel(absolute, activeRoot));
  }
  return dedupeLabels(labels);
}

export interface SpawnMining {
  pairs: EvalPair[];
  spawns: number;
  linked: number;
  unlinked: number;
  byMethod: Record<string, number>;
  /** Pairs with no resolvable briefing slug, where the date-order baseline can only miss. */
  withoutInitiative: number;
}

export async function mineSpawnArm(files: string[], activeRoot: string): Promise<SpawnMining> {
  const spawns = await collectSpawns(files);
  const heads = await Promise.all(files.map((file) => readHead(file)));
  const pairs: EvalPair[] = [];
  const byMethod: Record<string, number> = {};
  let linked = 0;
  let withoutInitiative = 0;
  for (const spawn of spawns) {
    const link = linkSpawn(spawn, heads);
    if (link === undefined) continue;
    linked++;
    byMethod[link.method] = (byMethod[link.method] ?? 0) + 1;
    const labels = await labelsFrom(link.transcript, activeRoot);
    if (labels.length === 0) continue;
    const initiative = briefingSlug(spawn, activeRoot);
    if (initiative === undefined) withoutInitiative++;
    pairs.push({
      arm: "spawn",
      id: `spawn:${spawn.name}:${transcriptId(link.transcript)}`,
      query: spawn.brief,
      labels,
      provenance: {
        queryTranscript: spawn.parentTranscript,
        labelTranscript: link.transcript,
        linkedBy: link.method,
        ...(initiative ? { initiative } : {}),
        ...(spawn.timestamp ? { timestamp: spawn.timestamp } : {}),
      },
    });
  }
  return { pairs, spawns: spawns.length, linked, unlinked: spawns.length - linked, byMethod, withoutInitiative };
}
