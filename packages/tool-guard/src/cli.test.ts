import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { denyCounts, isSafeLogPath, readWithin, runCli, SETTINGS_ENTRY, STDIN_TIMEOUT_MS } from "./cli.js";
import type { CliIo } from "./cli.js";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";

const HOME = "/home/you";
const LOG = `${HOME}/.local/state/titan-tool-guard/guard.log`;

interface Recorded {
  io: CliIo;
  out: string[];
  err: string[];
  writes: Array<{ file: string; lines: readonly string[] }>;
}

/** A fake io whose only write path, `appendLog`, records instead of writing. */
function fakeIo(stdin: string | null, files: Record<string, string> = {}): Recorded {
  const out: string[] = [];
  const err: string[] = [];
  const writes: Recorded["writes"] = [];
  const io: CliIo = {
    env: {},
    home: HOME,
    context: nodeContext(HOME, { realpath: () => { throw new Error("ENOENT"); }, readHead: () => "", isFile: () => false }),
    readStdin: async () => stdin,
    appendLog: (file, lines) => writes.push({ file, lines }),
    readFile: (file) => files[file] ?? null,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    loadDecide: async () => decide,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out, err, writes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("print-settings", () => {
  it("prints the PreToolUse entry as JSON and writes nothing", async () => {
    const { io, out, writes } = fakeIo(null);

    const code = await runCli(["print-settings"], io);

    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual(SETTINGS_ENTRY);
    expect(SETTINGS_ENTRY.matcher).toBe("Bash|Read|Grep|Edit|Write|MultiEdit|NotebookEdit");
    expect(writes).toEqual([]);
  });
});

describe("hook", () => {
  it("exits 0 with nothing on stdout when stdin times out", async () => {
    const { io, out, writes } = fakeIo(null);

    expect(await runCli(["hook"], io)).toBe(0);
    expect(out).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("prints a deny and appends its line to the default log", async () => {
    const event = JSON.stringify({ tool_name: "Read", cwd: "/tmp", tool_input: { file_path: `${HOME}/.npmrc` } });
    const { io, out, writes } = fakeIo(event);

    expect(await runCli(["hook"], io)).toBe(0);
    expect(out).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.file).toBe(LOG);
  });

  it("exits 0 when the log cannot be written", async () => {
    const recorded = fakeIo("not json");
    recorded.io.appendLog = () => {
      throw new Error("EACCES");
    };

    expect(await runCli(["hook"], recorded.io)).toBe(0);
  });

  it("never writes a log path that points at a guarded file", async () => {
    const recorded = fakeIo("not json");
    const io = { ...recorded.io, env: { TITAN_TOOL_GUARD_LOG: `${HOME}/.claude/settings.json` } };

    await runCli(["hook"], io);

    expect(recorded.writes).toEqual([]);
  });
});

describe("readWithin", () => {
  it("gives up after the timeout and releases stdin", async () => {
    vi.useFakeTimers();
    const stdin = new PassThrough();
    stdin.write("{");

    const pending = readWithin(stdin, STDIN_TIMEOUT_MS);
    vi.advanceTimersByTime(STDIN_TIMEOUT_MS);

    expect(await pending).toBeNull();
    expect(stdin.destroyed).toBe(true);
    expect(STDIN_TIMEOUT_MS).toBe(2000);
  });

  it("returns all of stdin when it ends in time", async () => {
    const stdin = new PassThrough();

    const pending = readWithin(stdin, STDIN_TIMEOUT_MS);
    stdin.end("{}");

    expect(await pending).toBe("{}");
  });
});

describe("report", () => {
  it("counts deny lines per day and rule, ignoring bypass and error lines", async () => {
    const log = [
      "2026-01-02T03:04:05.000Z\tdeny\tSEC-CO\tsecret-read",
      "2026-01-02T09:00:00.000Z\tdeny\tSEC-CO\tsecret-read",
      "2026-01-03T01:00:00.000Z\tdeny\tMRG-WK\tmerge",
      "2026-01-03T01:00:00.000Z\tbypass\tMRG-OT\tmerge",
      "2026-01-03T01:00:00.000Z\terror\tparse\tBash\t-",
      "",
    ].join("\n");
    const { io, out } = fakeIo(null, { [LOG]: log });

    expect(await runCli(["report"], io)).toBe(0);
    expect(out).toEqual(["2026-01-02\tSEC-CO\t2", "2026-01-03\tMRG-WK\t1"]);
  });

  it("prints nothing when there is no log", () => {
    expect(denyCounts("")).toEqual([]);
  });
});

describe("usage", () => {
  it("exits 2 for an unknown command", async () => {
    const { io, err } = fakeIo(null);

    expect(await runCli(["install"], io)).toBe(2);
    expect(err[0]).toMatch(/^usage: titan-tool-guard/);
  });
});

describe("isSafeLogPath", () => {
  it("accepts the default log and refuses guarded or relative paths", () => {
    expect(isSafeLogPath(LOG, HOME)).toBe(true);
    expect(isSafeLogPath(`${HOME}/.claude/x/../settings.json`, HOME)).toBe(false);
    expect(isSafeLogPath(`${HOME}/.npmrc`, HOME)).toBe(false);
    expect(isSafeLogPath("guard.log", HOME)).toBe(false);
  });
});
