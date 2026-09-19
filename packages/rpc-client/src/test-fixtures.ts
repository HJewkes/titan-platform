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
import type { DataSource } from "./client/data-source.js";

export interface Task {
  slug: string;
  title: string;
  status: "open" | "done";
  tags: string[];
}

export const TASKS: Task[] = [
  { slug: "a", title: "Write the client", status: "open", tags: ["rpc", "ui"] },
  { slug: "b", title: "Export a snapshot", status: "done", tags: ["rpc"] },
  { slug: "c", title: "Ship the report", status: "open", tags: ["ui"] },
];

const TaskListArgs = z.object({ status: z.enum(["open", "done"]).optional() });
const TaskFindArgs = z.object({ filter: z.object({ tags: z.array(z.string()), status: z.enum(["open", "done"]).optional() }) });

/** The query core a daemon and a static resolver would share: pure over the dataset. */
export function listTasks(tasks: Task[], args: z.infer<typeof TaskListArgs>): { slugs: string[] } {
  return { slugs: tasks.filter((t) => !args.status || t.status === args.status).map((t) => t.slug) };
}

function getTask(tasks: Task[], slug: string): Task {
  const task = tasks.find((t) => t.slug === slug);
  if (!task) throw Object.assign(new Error(`No task ${slug}`), { code: EXIT.NOINPUT });
  return task;
}

export const commands = {
  "task.list": defineCommand<z.infer<typeof TaskListArgs>, { slugs: string[] }>({
    name: "task.list",
    description: "List task slugs, optionally by status",
    args: TaskListArgs,
    result: z.object({ slugs: z.array(z.string()) }),
    run: async (args) => listTasks(TASKS, args),
  }),
  "task.get": defineCommand<{ slug: string }, Task>({
    name: "task.get",
    description: "One task by slug",
    args: z.object({ slug: z.string() }),
    result: z.custom<Task>(),
    run: async ({ slug }) => getTask(TASKS, slug),
  }),
  "task.find": defineCommand<z.infer<typeof TaskFindArgs>, { slugs: string[] }>({
    name: "task.find",
    description: "Tasks carrying every tag, optionally by status",
    args: TaskFindArgs,
    result: z.object({ slugs: z.array(z.string()) }),
    run: async ({ filter }) => ({
      slugs: TASKS.filter((t) => filter.tags.every((tag) => t.tags.includes(tag)))
        .filter((t) => !filter.status || t.status === filter.status)
        .map((t) => t.slug),
    }),
  }),
  "task.slow": defineCommand<{ ms: number }, { waited: number }>({
    name: "task.slow",
    description: "Answer after a delay, so a test can abort mid-flight",
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

/** The in-process caller a product hands `exportSnapshot`: its own registry, no server. */
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

/** A real daemon on an ephemeral loopback port, with default guards, restartable on the same port. */
export async function startTestDaemon(registry: CommandRegistry): Promise<TestDaemon> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "rpc-client-"));
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
