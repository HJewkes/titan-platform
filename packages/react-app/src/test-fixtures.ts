import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { silentLogger, startDaemon, type DaemonHandle } from "@titan-design/daemon";
import {
  EXIT,
  createRegistry,
  defineCommand,
  errorEnvelope,
  invokeCommand,
  type BaseContext,
  type CommandMapOf,
  type CommandRegistry,
  type JsonEnvelope,
} from "@titan-design/registry";
import { liveSource, type DataSource } from "@titan-design/rpc-client";

export interface Note {
  id: string;
  text: string;
  tags: string[];
}

const INITIAL: Note[] = [
  { id: "n1", text: "Wire the hooks", tags: ["ui"] },
  { id: "n2", text: "Serve the build", tags: ["daemon"] },
  { id: "n3", text: "Export a snapshot", tags: ["ui", "export"] },
];

/** Mutable so a test can change what the daemon answers, then broadcast that it changed. */
export const notes: Note[] = structuredClone(INITIAL);

export function resetNotes(): void {
  notes.splice(0, notes.length, ...structuredClone(INITIAL));
}

const ListArgs = z.object({ tag: z.string().optional() });

export const commands = {
  "note.list": defineCommand<z.infer<typeof ListArgs>, { ids: string[] }>({
    name: "note.list",
    description: "Note ids, optionally by tag",
    args: ListArgs,
    result: z.object({ ids: z.array(z.string()) }),
    run: async ({ tag }) => ({ ids: notes.filter((n) => !tag || n.tags.includes(tag)).map((n) => n.id) }),
  }),
  "note.get": defineCommand<{ id: string }, Note>({
    name: "note.get",
    description: "One note by id",
    args: z.object({ id: z.string() }),
    result: z.custom<Note>(),
    run: async ({ id }) => {
      const note = notes.find((n) => n.id === id);
      if (!note) throw Object.assign(new Error(`No note ${id}`), { code: EXIT.NOINPUT });
      return note;
    },
  }),
  "note.slow": defineCommand<{ ms: number }, { waited: number }>({
    name: "note.slow",
    description: "Answer after a delay, so a test can unmount mid-flight",
    args: z.object({ ms: z.number() }),
    result: z.object({ waited: z.number() }),
    run: async ({ ms }) => new Promise((resolve) => setTimeout(() => resolve({ waited: ms }), ms)),
  }),
};

export type Commands = CommandMapOf<typeof commands>;

export function createTestRegistry(): CommandRegistry {
  const registry = createRegistry();
  for (const cmd of Object.values(commands)) registry.register(cmd);
  return registry;
}

const context = (): BaseContext => ({ warnings: [], format: "json" });

/** The in-process caller an exporter hands `exportSnapshot`. */
export function registryCaller(registry: CommandRegistry): Pick<DataSource, "call"> {
  return {
    async call(name: string, args: unknown): Promise<JsonEnvelope<unknown>> {
      const cmd = registry.get(name);
      if (!cmd) return errorEnvelope(`Unknown command: ${name}`, EXIT.USAGE);
      return (await invokeCommand(cmd, args, context(), { invalidArgsCode: EXIT.DATAERR })).envelope;
    },
  };
}

export interface TestDaemon {
  handle: DaemonHandle;
  origin: string;
  restart(): Promise<void>;
  close(): Promise<void>;
}

/** A real daemon on an ephemeral loopback port with default guards, restartable on the same port. */
export async function startTestDaemon(registry: CommandRegistry): Promise<TestDaemon> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "react-app-"));
  const start = (port: number): Promise<DaemonHandle> =>
    startDaemon({ registry, createContext: context, version: "0.0.0-test", stateDir, port, shutdownGraceMs: 20, logger: silentLogger });
  const daemon: TestDaemon = {
    handle: await start(0),
    get origin() {
      return `http://127.0.0.1:${daemon.handle.port}`;
    },
    async restart() {
      const port = daemon.handle.port;
      await daemon.handle.close();
      daemon.handle = await start(port);
    },
    async close() {
      await daemon.handle.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
  return daemon;
}

export interface RecordedCall {
  name: string;
  args: unknown;
  signal: AbortSignal | undefined;
}

/** Wraps a source to record every call it receives, with the signal it was given. */
export function recordingSource(inner: DataSource): DataSource & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    call(name, args, options) {
      calls.push({ name, args, signal: options?.signal });
      return inner.call(name, args, options);
    },
    subscribe: (handlers, options) => inner.subscribe(handlers, options),
  };
}

/**
 * jsdom replaces `AbortSignal`, and Node's fetch refuses a foreign one. This fetch keeps the
 * abort semantics a browser has: the promise rejects with the reason and an open body is cancelled.
 */
export const jsdomSafeFetch: typeof fetch = (input, init) => {
  const { signal, ...rest } = init ?? {};
  if (!signal) return fetch(input, rest);
  return new Promise<Response>((resolve, reject) => {
    const abort = (response?: Response): void => {
      void response?.body?.cancel().catch(() => undefined);
      reject(signal.reason);
    };
    if (signal.aborted) return abort();
    fetch(input, rest).then((response) => {
      if (signal.aborted) return abort(response);
      signal.addEventListener("abort", () => void response.body?.cancel().catch(() => undefined), { once: true });
      resolve(response);
    }, reject);
    signal.addEventListener("abort", () => abort(), { once: true });
  });
};

export function testLiveSource(daemon: TestDaemon): DataSource {
  return liveSource({ origin: daemon.origin, fetch: jsdomSafeFetch, reconnectDelayMs: 20, maxReconnectDelayMs: 50 });
}
