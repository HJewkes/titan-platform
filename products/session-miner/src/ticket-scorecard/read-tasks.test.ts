import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadTasks } from "./read-tasks.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "read-tasks-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeTask(initiative: string, id: string, opts: { archived?: boolean; status?: string; mtimeSec?: number } = {}): string {
  const dir = path.join(root, initiative, "tasks", ...(opts.archived ? ["archive"] : []));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.yml`);
  const status = opts.status ?? "open";
  writeFileSync(file, stringify({ id, title: `Synthetic ${id}`, priority: 1, status, created: "2026-11-01", updated: "2026-11-01", done_at: null }));
  if (opts.mtimeSec !== undefined) utimesSync(file, opts.mtimeSec, opts.mtimeSec);
  return file;
}

describe("ticket-scorecard loadTasks over the pm reader", () => {
  it("loads archived task files alongside live ones", async () => {
    writeTask("alpha", "AA-1");
    writeTask("alpha", "AA-2", { archived: true });

    const load = await loadTasks(root, ["alpha"]);

    expect([...load.tasks.keys()].sort()).toEqual(["alpha/AA-1", "alpha/AA-2"]);
  });

  it("keeps the live file as the key when a live and an archived file share an id", async () => {
    writeTask("alpha", "AA-1", { status: "open" });
    writeTask("alpha", "AA-1", { status: "done", archived: true });

    const load = await loadTasks(root, ["alpha"]);

    expect(load.tasks.get("alpha/AA-1")?.status).toBe("open");
    expect(load.byId.get("AA-1")).toBe("alpha/AA-1");
  });

  it("reports the newest parsed row's mtime as maxMtimeMs", async () => {
    writeTask("alpha", "AA-1", { mtimeSec: 1_700_000_000 });
    writeTask("alpha", "AA-2", { archived: true, mtimeSec: 1_800_000_000 });

    const load = await loadTasks(root, ["alpha"]);

    expect(load.maxMtimeMs).toBe(1_800_000_000_000);
  });

  it("counts an unparsable file and lists an initiative with no tasks directory as missing", async () => {
    writeTask("alpha", "AA-1");
    writeFileSync(path.join(root, "alpha", "tasks", "broken.yml"), "id: [unclosed");

    const load = await loadTasks(root, ["alpha", "ghost"]);

    expect(load).toMatchObject({ unparsed: 1, missing: ["ghost"] });
    expect(load.tasks.size).toBe(1);
  });

  it("does not count an unparsable file's mtime in maxMtimeMs", async () => {
    writeTask("alpha", "AA-1", { mtimeSec: 1_700_000_000 });
    const broken = path.join(root, "alpha", "tasks", "broken.yml");
    writeFileSync(broken, "id: [unclosed");
    utimesSync(broken, 1_900_000_000, 1_900_000_000);

    const load = await loadTasks(root, ["alpha"]);

    expect(load.maxMtimeMs).toBe(1_700_000_000_000);
  });
});
