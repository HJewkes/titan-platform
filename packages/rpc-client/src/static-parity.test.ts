import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXIT, successEnvelope } from "@titan-design/rpc-protocol";
import { exportSnapshot } from "./node/index.js";
import { RpcError, createRpcClient, liveSource, parseSnapshot, staticSource, type DataSource, type SnapshotResolver } from "./index.js";
import { TASKS, createTestRegistry, listTasks, registryCaller, startTestDaemon, type Commands, type Task, type TestDaemon } from "./test-fixtures.js";

/** Report-app code: it knows the command map and nothing about where answers come from. */
async function reportView(source: DataSource) {
  const client = createRpcClient<Commands>(source);
  const failure = (err: unknown) => (err instanceof RpcError ? { failed: err.code, message: err.message } : err);
  return {
    open: await client.call("task.list", { status: "open" }),
    all: await client.call("task.list"),
    task: await client.call("task.get", { slug: "b" }),
    tagged: await client.call("task.find", { filter: { status: "open", tags: ["ui"] } }),
    missing: await client.call("task.get", { slug: "zzz" }).catch(failure),
    invalid: await client.call("task.get", { slug: 7 as unknown as string }).catch(failure),
  };
}

/** The recording plan: the same calls, with args spelled in a different key order. */
const PLAN = [
  { command: "task.list", args: { status: "open" } },
  { command: "task.list" },
  { command: "task.get", args: { slug: "b" } },
  { command: "task.find", args: { filter: { tags: ["ui"], status: "open" } } },
  { command: "task.get", args: { slug: "zzz" } },
  { command: "task.get", args: { slug: 7 } },
];

let daemon: TestDaemon;
let dir: string;

beforeEach(async () => {
  const registry = createTestRegistry();
  daemon = await startTestDaemon(registry);
  dir = await mkdtemp(path.join(tmpdir(), "rpc-client-snapshot-"));
});

afterEach(async () => {
  await daemon.close();
  await rm(dir, { recursive: true, force: true });
});

async function loadSnapshot(file: string) {
  return parseSnapshot(JSON.parse(await readFile(file, "utf8")));
}

describe("static export parity", () => {
  it("gives the same results from an exported snapshot as from the live daemon", async () => {
    const file = path.join(dir, "report", "snapshot.json");
    await exportSnapshot(file, registryCaller(createTestRegistry()), { calls: PLAN });

    const live = await reportView(liveSource({ origin: daemon.origin }));
    const offline = await reportView(staticSource({ snapshot: await loadSnapshot(file) }));

    expect(offline).toEqual(live);
    expect(live.missing).toEqual({ failed: EXIT.NOINPUT, message: "No task zzz" });
    expect(live.tagged).toEqual({ slugs: ["a", "c"] });
  });

  it("exports through a live daemon too, since any source can record", async () => {
    const file = path.join(dir, "via-live.json");
    const written = await exportSnapshot(file, liveSource({ origin: daemon.origin }), { calls: PLAN });
    expect(await loadSnapshot(file)).toEqual(written);
    expect(Object.keys(written.calls)).toHaveLength(PLAN.length);
  });

  it("answers from a dataset through a resolver sharing the daemon's query core", async () => {
    const resolve: SnapshotResolver<Task[]> = (command, args, tasks) =>
      command === "task.list"
        ? successEnvelope(listTasks(tasks, args as Parameters<typeof listTasks>[1]))
        : { ok: false, error: `${command} is not available in a static dataset`, code: EXIT.UNAVAILABLE };
    const file = path.join(dir, "dataset.json");
    await exportSnapshot(file, registryCaller(createTestRegistry()), { dataset: TASKS });
    const offline = createRpcClient<Commands>(staticSource({ snapshot: await loadSnapshot(file), resolve: resolve as SnapshotResolver }));
    const live = createRpcClient<Commands>(liveSource({ origin: daemon.origin }));

    expect(await offline.call("task.list", { status: "open" })).toEqual(await live.call("task.list", { status: "open" }));
    await expect(offline.call("task.get", { slug: "a" })).rejects.toMatchObject({ code: EXIT.UNAVAILABLE });
  });
});
