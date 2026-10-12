import type { EventHub } from "@titan-design/daemon";
import type { Db } from "@titan-design/store-sqlite";
import type { WorkflowEvent } from "@titan-design/workflow";
import { openFactoryHost, type FactoryHost, type FactoryHostOptions, type FactoryRoutes } from "../host.js";
import type { ShepherdServices } from "./commands.js";
import type { Registration } from "./store.js";

export const SHEPHERD_FRAME_EVENT = "shepherd";
const FRAME_COALESCE_MS = 250;
const FRAME_POLL_MS = 1_000;

type ShepherdFrameKind = "run" | "gate" | "registration" | "external";

/** A refetch hint for the console: which run moved and how, never the payload; a breaking change bumps `v`. */
export interface ShepherdFrame {
  v: 1;
  kind: ShepherdFrameKind;
  repo?: string;
  pr?: number;
  runId?: string;
  stepId?: string;
  at: string;
}

interface ShepherdFramesOptions {
  coalesceMs?: number;
  pollMs?: number;
  now?: () => number;
  /** The registration behind a run, so run and gate frames carry its repo and PR; absent or throwing means they carry neither. */
  registrationOf?: (runId: string) => { repo: string; pr: number | null } | undefined;
}

interface ShepherdFrames {
  onEvent(event: WorkflowEvent): void;
  onChange(change: Pick<Registration, "repo" | "pr" | "runId">): void;
  /** Frames go nowhere until the hub exists; `db` must be the connection this process writes through, so its own commits never read as external. */
  start(hub: EventHub, db: Db): void;
  /** Stops the poll and drops every pending frame. Idempotent. */
  close(): void;
}

export interface FramedHostOptions {
  /** How often /events checks the database for another process's commit; defaults to `FRAME_POLL_MS`. */
  framePollMs?: number;
}

/** What serve holds: frames start with the daemon's hub and stop before the host closes the database. */
interface ServeFrames {
  started<T extends { hub: EventHub }>(daemon: T): T;
  stop(): void;
}

/** The host's own connection is tapped through a tenant, so the poll reads `data_version` where this process writes and only other processes' commits show as external. */
export function openFramedHost(options: FactoryHostOptions & FramedHostOptions): { host: FactoryHost; frames: ServeFrames } {
  let db: Db | undefined;
  const services = options.routes.shepherd;
  const source = shepherdFrames({ pollMs: options.framePollMs, now: options.now, registrationOf: services && ((runId) => services.store.get().byRun(runId)) });
  const routes = tapDatabase(options.routes, (opened) => (db = opened));
  const host = openFactoryHost({ ...options, routes, onEvent: (event) => (options.onEvent?.(event), source.onEvent(event)) });
  const unlisten = subscribe(services, source);
  return {
    host,
    frames: {
      started: (daemon) => (source.start(daemon.hub, db!), daemon),
      stop: () => (source.close(), unlisten?.()),
    },
  };
}

/** A route set without a store, as some tests pass, has no registrations to hear. */
function subscribe(services: ShepherdServices | undefined, source: ShepherdFrames): (() => void) | undefined {
  return services?.store?.onChange?.(source.onChange);
}

function tapDatabase(routes: FactoryRoutes, tap: (db: Db) => void): FactoryRoutes {
  const tenant = routes.database;
  const database = { extraMigrations: tenant?.extraMigrations ?? [], bind: (db: Db) => (tap(db), tenant?.bind(db) ?? (() => undefined)) };
  return Object.assign([...routes], routes, { database });
}

type Pending = { frame: ShepherdFrame; timer: ReturnType<typeof setTimeout> };

interface Coalescer {
  push(frame: ShepherdFrame): void;
  clear(): void;
}

/** Host events, store writes and other connections' commits become `shepherd` frames, at most one per run per window. */
export function shepherdFrames(options: ShepherdFramesOptions = {}): ShepherdFrames {
  const now = options.now ?? Date.now;
  const at = (): string => new Date(now()).toISOString();
  let hub: EventHub | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const pending = coalescer(options.coalesceMs ?? FRAME_COALESCE_MS, (frame) => hub?.broadcast({ event: SHEPHERD_FRAME_EVENT, data: JSON.stringify(frame) }));
  const emit = (frame: ShepherdFrame): void => void (!closed && hub !== undefined && pending.push(frame));
  return {
    onEvent: (event) => emit({ v: 1, kind: kindOf(event), ...registrationFields(options.registrationOf, event.runId), runId: event.runId, ...("stepId" in event && { stepId: event.stepId }), at: at() }),
    onChange: ({ repo, pr, runId }) => emit({ v: 1, kind: "registration", repo, ...(pr !== null && { pr }), runId, at: at() }),
    start(nextHub, db) {
      if (closed) return;
      hub = nextHub;
      poll = pollCommits(db, options.pollMs ?? FRAME_POLL_MS, () => emit({ v: 1, kind: "external", at: at() }));
    },
    close() {
      closed = true;
      clearInterval(poll);
      pending.clear();
    },
  };
}

/** The trailing frame of a window wins; frames without a run, as external ones are, share a window per kind and repo. */
function coalescer(windowMs: number, send: (frame: ShepherdFrame) => void): Coalescer {
  const pending = new Map<string, Pending>();
  const flush = (key: string): void => {
    const entry = pending.get(key);
    pending.delete(key);
    if (entry) send(entry.frame);
  };
  return {
    push(frame) {
      const key = frame.runId ?? `${frame.kind}:${frame.repo ?? ""}`;
      const queued = pending.get(key);
      if (queued) queued.frame = frame;
      else pending.set(key, { frame, timer: setTimeout(() => flush(key), windowMs) });
    },
    clear() {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}

function pollCommits(db: Db, pollMs: number, onCommit: () => void): ReturnType<typeof setInterval> {
  let seen = dataVersion(db);
  const poll = setInterval(() => {
    const version = dataVersion(db);
    if (version !== seen) onCommit();
    seen = version;
  }, pollMs);
  poll.unref?.();
  return poll;
}

function kindOf(event: WorkflowEvent): ShepherdFrameKind {
  return event.type === "gate_opened" ? "gate" : "run";
}

function registrationFields(registrationOf: ShepherdFramesOptions["registrationOf"], runId: string): { repo?: string; pr?: number } {
  try {
    const registration = registrationOf?.(runId);
    return registration ? { repo: registration.repo, ...(registration.pr !== null && { pr: registration.pr }) } : {};
  } catch {
    return {};
  }
}

/** Changes only when another connection commits, which is what makes a CLI's gate resolve `external` and this process's writes not. */
function dataVersion(db: Db): number {
  return db.pragma("data_version", { simple: true }) as number;
}
