import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHttpApp } from "@titan-design/daemon";
import { createRegistry, inProcessCaller } from "@titan-design/registry";
import { postReport } from "../../src/data/perf.js";
import type { ConsoleContext } from "../owner-guard.js";
import { consoleContextFor } from "../registry.js";
import { makeLogDir, readLogText, removeDir } from "../perf-recorder.test-helpers.js";
import { PERF_REPORT, PERF_REPORT_BODY_LIMIT, perfCommands } from "./commands.js";
import { createPerfRecorder } from "./recorder.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const REGISTERED = ["work.tasks", "inbox.list"];

let logDir: string;
beforeEach(() => {
  logDir = makeLogDir();
});
afterEach(() => removeDir(logDir));

async function report(args: unknown, surface: ConsoleContext["surface"] = "http") {
  const recorder = createPerfRecorder({ dir: logDir, now: () => NOW });
  const registry = createRegistry<ConsoleContext>();
  registry.register(perfCommands(recorder, () => REGISTERED)["perf.report"]);
  const context = (): ConsoleContext => ({ warnings: [], format: "json", surface, auth: null, ownerWrites: false });
  const answer = await inProcessCaller(registry, context)("perf.report", args);
  await recorder.close();
  return answer;
}

const logged = (): unknown[] => readLogText(logDir).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

describe("perf.report", () => {
  it("logs the route and query rows it is given", async () => {
    const answer = await report({
      rows: [
        { kind: "route", view: "tasks", detail: true, ms: 840, queries: 2 },
        { kind: "query", command: "work.tasks", ms: 800, ok: true, fromCache: false },
      ],
      dropped: 3,
    });

    expect(answer).toMatchObject({ ok: true, data: { accepted: 2 } });
    expect(logged()).toEqual([
      { t: NOW, kind: "route", view: "tasks", detail: true, ms: 840, queries: 2 },
      { t: NOW, kind: "query", command: "work.tasks", ms: 800, ok: true, fromCache: false },
      { t: NOW, kind: "dropped", count: 3 },
    ]);
  });

  it("refuses an unknown view or command name", async () => {
    const unknownView = await report({ rows: [{ kind: "route", view: "secret-room", detail: false, ms: 1, queries: 1 }] });
    const unknownCommand = await report({ rows: [{ kind: "query", command: "not.a.command", ms: 1, ok: true, fromCache: false }] });

    expect(unknownView.ok).toBe(false);
    expect(unknownCommand.ok).toBe(false);
    expect(existsSync(logDir)).toBe(false);
  });

  it("refuses a row that carries an id or any field it does not know", async () => {
    const answer = await report({ rows: [{ kind: "route", view: "tasks", detail: true, ms: 1, queries: 1, id: "TP-1" }] });

    expect(answer.ok).toBe(false);
  });

  it("refuses more than 100 rows in one post", async () => {
    const rows = Array.from({ length: 101 }, () => ({ kind: "route", view: "home", detail: false, ms: 1, queries: 1 }));

    expect((await report({ rows })).ok).toBe(false);
  });

  it("refuses a call made inside the daemon rather than over HTTP", async () => {
    const answer = await report({ rows: [] }, "in-process");

    expect(answer.ok).toBe(false);
  });
});

describe("perf.report over HTTP", () => {
  it("accepts the post the browser sends through the daemon's default guard", async () => {
    const recorder = createPerfRecorder({ dir: logDir, now: () => NOW });
    const registry = createRegistry<ConsoleContext>();
    registry.register(perfCommands(recorder, () => REGISTERED)[PERF_REPORT]);
    const app = buildHttpApp({ registry, createContext: consoleContextFor(false), version: "test", port: () => 7400, rpcBodyLimit: { perCommand: { [PERF_REPORT]: PERF_REPORT_BODY_LIMIT } } });
    const answers: Response[] = [];
    // The browser adds Host and Origin to a same-origin post; `keepalive` stays in the browser and never reaches the wire.
    const browser = async (url: string, { keepalive: _, ...init }: RequestInit): Promise<void> => {
      answers.push(await app.request(`http://localhost:7400${url}`, { ...init, headers: { ...(init.headers as Record<string, string>), origin: "http://localhost:7400" } }));
    };

    postReport({ rows: [{ kind: "route", view: "home", detail: false, ms: 12, queries: 1 }], dropped: 0 }, browser);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    await recorder.close();

    expect(answers[0]?.status).toBe(200);
    expect(logged()).toEqual([{ t: NOW, kind: "route", view: "home", detail: false, ms: 12, queries: 1 }]);
  });
});
