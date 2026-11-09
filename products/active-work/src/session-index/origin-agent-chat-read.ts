import { isObjectLike, isRecord } from '@titan-design/rpc-protocol/narrow';
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIFECYCLE_KINDS = [
  'agent_spawned',
  'agent_attached',
  'agent_resumed',
  'agent_handoff',
  'agent_retired',
  'agent_exited',
] as const;

/** One `events` row, with `ts` in epoch milliseconds and `meta` parsed. */
export interface LifecycleEvent {
  ts: number;
  kind: string;
  actor: string;
  target: string | null;
  ref: string | null;
  meta: Record<string, unknown>;
}

interface LaunchPlan {
  path: string;
  brief: string;
}

/** A message that handed its recipient more work, by the sender's stated reason (CC-168). */
export interface FollowUp {
  ts: number;
  target: string;
  kind: string;
}

/** What the resolver needs from a launcher: its lifecycle rows, follow-ups and each agent's brief. */
export interface SpawnSource {
  /** Agent lifecycle rows, oldest first; empty when the launcher has no record. */
  events(): LifecycleEvent[];
  /** Messages carrying a follow-up kind, oldest first. */
  followUps(): FollowUp[];
  plan(agentId: string): LaunchPlan | null;
}

export type OpenDatabase = (file: string, options: Database.Options) => Database.Database;

const openBetterSqlite: OpenDatabase = (file, options) => new Database(file, options);

/** A locked `events.db` is not worth better-sqlite3's default 5 s busy wait: origins and skipping are only savings. */
const EVENTS_BUSY_TIMEOUT_MS = 100;

export const openBriefly: OpenDatabase = (file, options) =>
  new Database(file, { ...options, timeout: EVENTS_BUSY_TIMEOUT_MS });

export function agentChatHome(): string {
  return process.env.AGENT_CHAT_HOME ?? path.join(os.homedir(), '.agent-chat');
}

/** agent-chat's `events.db` and `agents/<id>/plan.json`, never opened for writing. */
export function eventsDbSource(
  home: string = agentChatHome(),
  open: OpenDatabase = openBetterSqlite,
): SpawnSource {
  return {
    events: () => readLifecycleEvents(path.join(home, 'events.db'), open),
    followUps: () => readFollowUps(path.join(home, 'events.db'), open),
    plan: (agentId) => readPlan(path.join(home, 'agents', agentId, 'plan.json')),
  };
}

function readLifecycleEvents(file: string, open: OpenDatabase): LifecycleEvent[] {
  if (!existsSync(file)) return [];
  const db = open(file, { readonly: true, fileMustExist: true });
  try {
    const kinds = LIFECYCLE_KINDS.map(() => '?').join(', ');
    const rows = db
      .prepare<string[], Omit<LifecycleEvent, 'meta'> & { meta: string | null }>(
        `SELECT ts, kind, actor, target, ref, meta FROM events WHERE kind IN (${kinds}) ORDER BY id`,
      )
      .all(...LIFECYCLE_KINDS);
    return rows.map((row) => ({ ...row, meta: parseMeta(row.meta) }));
  } finally {
    db.close();
  }
}

/** One row per recipient, so `target` is always the agent that received it. */
function readFollowUps(file: string, open: OpenDatabase): FollowUp[] {
  if (!existsSync(file)) return [];
  const db = open(file, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare<[], FollowUp>(
        `SELECT ts, target, json_extract(meta, '$.followup_kind') AS kind FROM events
         WHERE kind = 'message' AND target IS NOT NULL
           AND json_extract(meta, '$.followup_kind') IS NOT NULL
         ORDER BY id`,
      )
      .all();
  } finally {
    db.close();
  }
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObjectLike(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Headless launches pipe the brief on `stdin`; pane launches pass it as the
 * positional prompt after `--`, which is 1,134 of 1,278 plans as of 2026-09-23.
 */
function readPlan(file: string): LaunchPlan | null {
  let plan: unknown;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(plan)) return null;
  const brief = typeof plan.stdin === 'string' ? plan.stdin : promptArg(plan.args);
  return brief === null ? null : { path: file, brief };
}

function promptArg(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  const prompt: unknown = args[args.lastIndexOf('--') + 1];
  return args.includes('--') && typeof prompt === 'string' ? prompt : null;
}
