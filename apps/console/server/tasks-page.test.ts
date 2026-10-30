import { afterEach, describe, expect, it } from "vitest";
import { invokeCommand } from "@titan-design/registry";
import { activeWorkClient } from "./active-work.js";
import { tasksCommands } from "./tasks.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

// Synthetic tasks, many and long-winded, so a page's size is what a large workspace would send; nothing here is real.
const SLUGS = Array.from({ length: 40 }, (_, n) => `synthetic-initiative-${String(n).padStart(2, "0")}`);
const TASK_COUNT = 2400;
const LONG = "a deliberately long synthetic sentence that pads each record ".repeat(6);

const TASKS = Array.from({ length: TASK_COUNT }, (_, n) => ({
  slug: SLUGS[n % SLUGS.length]!,
  id: `SY-${n + 1}`,
  title: `Synthetic task ${n + 1}: ${LONG.slice(0, 120)}`,
  priority: n + 1,
  severity: ["critical", "high", "medium", "low"][n % 4],
  status: "open",
  created: "2031-01-05",
  updated: "2031-03-01",
  done_at: null,
  tags: ["synthetic", `area:${n % 7}`, ...(n % 5 === 0 && n > 0 ? [`dep:SY-${n}`] : [])],
  deliverables: [`deliverable-${n % 9}`],
  notes: LONG,
  done_when: LONG,
}));

const KB = 1024;
const BUDGET = 100 * KB;

let daemon: FakeDaemon | undefined;

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

function answer(command: string, args: Record<string, unknown>): unknown {
  if (command === "task.list") return { tasks: TASKS.filter((entry) => args.slug === undefined || entry.slug === args.slug) };
  if (command === "artifact.list") return { items: [] };
  throw new Error(`No answer for ${command}`);
}

async function listTasks(args: Record<string, unknown>) {
  daemon ??= await startFakeDaemon({ ok: true }, answer);
  const source = { activeWork: activeWorkClient(daemon.port), sessions: { graphPath: "/nonexistent/graph.sqlite3" }, evidence: async () => [] };
  const command = tasksCommands(source)["work.tasks"];
  const { envelope } = await invokeCommand(command, args, { warnings: [], format: "json" });
  if (!envelope.ok) throw new Error(envelope.error);
  return { bytes: JSON.stringify(envelope).length, data: command.result.parse(envelope.data) };
}

describe("work.tasks over a workspace of thousands of open tasks", () => {
  it("answers the default read with 50 rows under 100 KB, counting every open task", async () => {
    const { bytes, data } = await listTasks({});
    expect(data.tasks).toHaveLength(50);
    expect(Object.values(data.counts).reduce((sum, count) => sum + count, 0)).toBe(TASK_COUNT);
    expect(bytes).toBeLessThan(BUDGET);
  });

  it("answers the selected initiative's open tasks only, under the same budget", async () => {
    const { bytes, data } = await listTasks({ initiative: SLUGS[3] });
    expect(new Set(data.tasks.map((row) => row.slug))).toEqual(new Set([SLUGS[3]]));
    expect(data.initiatives).toHaveLength(SLUGS.length);
    expect(bytes).toBeLessThan(BUDGET);
  });

  it("reaches every open task once by following the cursor", async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    // Bounded so a cursor that never advances fails the count instead of hanging the run.
    for (let pages = 0; pages <= TASK_COUNT / 200; pages++) {
      const { data }: Awaited<ReturnType<typeof listTasks>> = await listTasks({ limit: 200, ...(cursor ? { cursor } : {}) });
      for (const row of data.tasks) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      cursor = data.nextCursor;
      if (cursor === null) break;
    }
    expect(seen.size).toBe(TASK_COUNT);
  });
});
