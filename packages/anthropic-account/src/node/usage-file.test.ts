import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ChildProcess } from "node:child_process";
import { CANARY, FAKE_ACCESS_TOKEN, FAKE_JWT, FAKE_OPAQUE } from "../fixtures/fake-tokens.js";
import {
  captureOutput,
  errorText,
  makeFifo,
  makeTempHome,
  removeTempHome,
  swapAfterLstat,
  thrown,
  unblockFifoLater,
  writeFileWithMode,
} from "../fixtures/temp-home.js";
import type { UsageReading } from "../usage.js";
import { MAX_READING_BYTES, USAGE_FILE, readUsage, sessionsDir, usageFilePath, writeReading } from "./usage-file.js";

const WRITTEN_AT = 1_791_460_800;

const reading = (overrides: Partial<UsageReading> = {}): UsageReading => ({
  session_id: "usage-poll",
  written_at: WRITTEN_AT,
  rate_limits: {
    five_hour: { used_percentage: 23, resets_at: WRITTEN_AT + 18_000 },
    seven_day: { used_percentage: 41.5, resets_at: WRITTEN_AT + 334_800 },
  },
  source: "oauth-usage",
  account: "agents",
  ...overrides,
});

// agent-chat's acceptance rules, restated: parseBudget (src/agents/budget.ts:198-223) needs a
// JSON object with a non-empty string session_id and a finite number written_at, and
// parseWindows (:270-280) keeps a window only when used_percentage is a finite number, with
// resets_at optional. readAccountBudget (:415-428) reads every `.json` name in the dir, and
// budgetPath (:120-126) takes the name, less `.json`, only if it is 1-128 of [A-Za-z0-9_-].
const finite = z.number().refine(Number.isFinite);
const agentChatBudget = z.looseObject({
  session_id: z.string().min(1),
  written_at: finite,
  rate_limits: z.record(z.string(), z.looseObject({ used_percentage: finite, resets_at: finite.optional() })),
});
const AGENT_CHAT_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

let home: string;
let configDir: string;
let output: ReturnType<typeof captureOutput>;

beforeEach(() => {
  home = makeTempHome();
  configDir = path.join(home, ".claude");
  output = captureOutput();
});

afterEach(() => {
  output.restore();
  vi.restoreAllMocks();
  removeTempHome(home);
});

function writeSessionFile(name: string, value: unknown): void {
  writeFileWithMode(path.join(sessionsDir(configDir), name), JSON.stringify(value), 0o600);
}

describe("writeReading", () => {
  it("writes usage-poll.json, mode 0600, holding the reading", () => {
    const file = writeReading(configDir, reading());

    expect(file).toBe(path.join(configDir, "status-cache", "sessions", "usage-poll.json"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(reading());
  });

  it("writes a file agent-chat's parseBudget rules accept, every window kept", () => {
    const file = writeReading(configDir, reading());

    const names = fs.readdirSync(sessionsDir(configDir)).filter((name) => name.endsWith(".json"));
    const parsed = agentChatBudget.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));

    expect(names).toEqual([USAGE_FILE]);
    expect(names.every((name) => AGENT_CHAT_SESSION_ID.test(name.slice(0, -".json".length)))).toBe(true);
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data?.rate_limits ?? {})).toEqual(["five_hour", "seven_day"]);
  });

  it("writes only the fields a reading has", () => {
    const file = writeReading(configDir, { ...reading(), extra: "dropped" } as UsageReading);

    expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")))).not.toContain("extra");
  });

  it("replaces an existing, wider file with an owner-only one", () => {
    writeFileWithMode(usageFilePath(configDir), "{}", 0o644);

    writeReading(configDir, reading({ written_at: WRITTEN_AT + 1 }));

    expect(fs.statSync(usageFilePath(configDir)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(usageFilePath(configDir), "utf8")).written_at).toBe(WRITTEN_AT + 1);
  });

  it("fsyncs a complete owner-only temp file in the same dir before the rename", () => {
    const fsync = vi.spyOn(fs, "fsyncSync");
    const seen: { dir: string; mode: number; text: string; fsyncs: number }[] = [];
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      const temp = String(from);
      seen.push({
        dir: path.dirname(temp),
        mode: fs.statSync(temp).mode & 0o777,
        text: fs.readFileSync(temp, "utf8"),
        fsyncs: fsync.mock.calls.length,
      });
      realRename(from, to);
    });

    writeReading(configDir, reading());

    expect(seen).toEqual([
      { dir: sessionsDir(configDir), mode: 0o600, text: `${JSON.stringify(reading())}\n`, fsyncs: 1 },
    ]);
  });

  it("leaves no temp file behind and the old reading in place when the rename fails", () => {
    writeReading(configDir, reading());
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename ${FAKE_ACCESS_TOKEN}`), {
        code: "EXDEV",
      });
    });

    const error = thrown(() => writeReading(configDir, reading({ written_at: WRITTEN_AT + 1 })));

    expect(errorText(error)).toContain("EXDEV");
    expect(errorText(error)).not.toContain(CANARY);
    expect((error as Error).cause).toBeUndefined();
    expect(fs.readdirSync(sessionsDir(configDir))).toEqual([USAGE_FILE]);
    expect(JSON.parse(fs.readFileSync(usageFilePath(configDir), "utf8")).written_at).toBe(WRITTEN_AT);
  });

  it("redacts a token-shaped path from a filesystem error", () => {
    const blocker = path.join(home, FAKE_ACCESS_TOKEN);
    fs.writeFileSync(blocker, "");

    const error = thrown(() => writeReading(blocker, reading()));

    expect(errorText(error)).toContain("ENOTDIR");
    expect(errorText(error)).not.toContain(CANARY);
  });

  it.each([
    ["another session id", reading({ session_id: "abc" })],
    ["an invalid reading", reading({ written_at: -1 })],
    ["a token in the account", reading({ account: FAKE_ACCESS_TOKEN })],
    ["a token as a window name", reading({ rate_limits: { [FAKE_ACCESS_TOKEN]: { used_percentage: 1 } } })],
  ])("refuses %s, writing nothing and quoting nothing", (_, bad) => {
    const error = thrown(() => writeReading(configDir, bad));

    expect(error).toBeInstanceOf(TypeError);
    expect(errorText(error)).not.toContain(CANARY);
    expect(fs.existsSync(sessionsDir(configDir))).toBe(false);
    expect(output.text()).toBe("");
  });
});

describe("readUsage", () => {
  it("returns nothing for a config dir with no sessions dir", () => {
    expect(readUsage(configDir, { now: WRITTEN_AT * 1000 })).toBeNull();
  });

  it("reads back what writeReading wrote, with its age", () => {
    writeReading(configDir, reading());

    expect(readUsage(configDir, { now: (WRITTEN_AT + 90) * 1000 + 999 })).toEqual({
      reading: reading(),
      file: usageFilePath(configDir),
      ageSeconds: 90,
    });
  });

  it("picks the newest reading across the poller's file and status-line sessions", () => {
    writeReading(configDir, reading());
    writeSessionFile("session-a.json", { ...reading({ session_id: "session-a", written_at: WRITTEN_AT + 60 }), cwd: "/x" });
    writeSessionFile("session-b.json", reading({ session_id: "session-b", written_at: WRITTEN_AT - 60 }));

    const read = readUsage(configDir, { now: (WRITTEN_AT + 60) * 1000 });

    expect(read?.reading.session_id).toBe("session-a");
    expect(read?.ageSeconds).toBe(0);
  });

  it("skips malformed, windowless, symlinked and temp files", () => {
    writeReading(configDir, reading());
    const newer = reading({ written_at: WRITTEN_AT + 60 });
    writeFileWithMode(path.join(sessionsDir(configDir), "torn.json"), '{"session_id":"torn",', 0o600);
    writeSessionFile("empty.json", { ...newer, session_id: "empty", rate_limits: {} });
    writeSessionFile(".usage-poll.json.1.ab.tmp", newer);
    writeFileWithMode(path.join(home, "target.json"), JSON.stringify(newer), 0o600);
    fs.symlinkSync(path.join(home, "target.json"), path.join(sessionsDir(configDir), "linked.json"));

    expect(readUsage(configDir, { now: WRITTEN_AT * 1000 })?.file).toBe(usageFilePath(configDir));
  });

  it("redacts a token-shaped session_id, account or source it returns", () => {
    writeSessionFile("s.json", reading({ session_id: FAKE_OPAQUE, account: FAKE_ACCESS_TOKEN, source: FAKE_JWT }));

    const read = readUsage(configDir, { now: WRITTEN_AT * 1000 });

    expect(read?.reading.rate_limits).toEqual(reading().rate_limits);
    expect(JSON.stringify(read)).not.toContain(CANARY);
  });

  it("never reports a negative age for a reading from the future", () => {
    writeReading(configDir, reading());

    expect(readUsage(configDir, { now: (WRITTEN_AT - 30) * 1000 })?.ageSeconds).toBe(0);
  });
});

describe("readUsage reads the file it checked", () => {
  let unblocker: ChildProcess | undefined;

  afterEach(() => {
    unblocker?.kill();
    unblocker = undefined;
  });

  const sessionFile = (): string => path.join(sessionsDir(configDir), "s.json");

  it.skipIf(process.platform === "win32")(
    "returns promptly when a file is swapped for a symlink to a FIFO after the lstat",
    () => {
      writeSessionFile("s.json", reading({ session_id: "s" }));
      const fifo = path.join(home, "pipe");
      makeFifo(fifo);
      unblocker = unblockFifoLater(fifo);
      swapAfterLstat(sessionFile(), () => {
        fs.rmSync(sessionFile());
        fs.symlinkSync(fifo, sessionFile());
      });
      const started = Date.now();

      const read = readUsage(configDir, { now: WRITTEN_AT * 1000 });

      expect(Date.now() - started).toBeLessThan(500);
      expect(read).toBeNull();
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "returns promptly when a FIFO is renamed over the file after the lstat",
    () => {
      writeSessionFile("s.json", reading({ session_id: "s" }));
      const fifo = path.join(sessionsDir(configDir), "pipe");
      makeFifo(fifo);
      // The rename moves the FIFO, so the unblocker opens it where the reader will.
      unblocker = unblockFifoLater(sessionFile());
      swapAfterLstat(sessionFile(), () => fs.renameSync(fifo, sessionFile()));
      const read = vi.spyOn(fs, "readSync");
      const started = Date.now();

      const result = readUsage(configDir, { now: WRITTEN_AT * 1000 });

      expect(Date.now() - started).toBeLessThan(500);
      expect(result).toBeNull();
      expect(read).not.toHaveBeenCalled();
    },
    15_000,
  );

  // The dev/ino check alone would refuse this too, so only O_NOFOLLOW keeps the symlink
  // from being followed to the very inode the lstat saw.
  it("does not follow a symlink to the same file swapped in after the lstat", () => {
    writeSessionFile("s.json", reading({ session_id: "s" }));
    const moved = path.join(home, "moved.json");
    swapAfterLstat(sessionFile(), () => {
      fs.renameSync(sessionFile(), moved);
      fs.symlinkSync(moved, sessionFile());
    });
    const read = vi.spyOn(fs, "readSync");

    expect(readUsage(configDir, { now: WRITTEN_AT * 1000 })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("does not follow a symlink to a reading outside the dir swapped in after the lstat", () => {
    writeSessionFile("s.json", reading({ session_id: "s" }));
    const outside = path.join(home, "outside.json");
    writeFileWithMode(outside, JSON.stringify(reading({ session_id: "outside" })), 0o600);
    swapAfterLstat(sessionFile(), () => {
      fs.rmSync(sessionFile());
      fs.symlinkSync(outside, sessionFile());
    });

    expect(readUsage(configDir, { now: WRITTEN_AT * 1000 })).toBeNull();
  });

  it("does not read past the cap a file that grew after the lstat", () => {
    writeSessionFile("s.json", reading({ session_id: "s" }));
    swapAfterLstat(sessionFile(), () => fs.appendFileSync(sessionFile(), " ".repeat(MAX_READING_BYTES)));

    expect(readUsage(configDir, { now: WRITTEN_AT * 1000 })).toBeNull();
  });
});

describe("writeReading beside another writer", () => {
  it("lands one whole reading and no temp file when a second write runs mid-write", () => {
    writeReading(configDir, reading());
    const realRename = fs.renameSync;
    const temps: string[] = [];
    let seenMidWrite: ReturnType<typeof readUsage> = null;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      temps.push(String(from));
      if (temps.length === 1) {
        seenMidWrite = readUsage(configDir, { now: WRITTEN_AT * 1000 });
        writeReading(configDir, reading({ written_at: WRITTEN_AT + 2 }));
      }
      realRename(from, to);
    });

    writeReading(configDir, reading({ written_at: WRITTEN_AT + 1 }));

    expect(seenMidWrite).toMatchObject({ reading: reading() });
    expect(new Set(temps).size).toBe(2);
    expect(fs.readdirSync(sessionsDir(configDir))).toEqual([USAGE_FILE]);
    expect(JSON.parse(fs.readFileSync(usageFilePath(configDir), "utf8"))).toEqual(
      reading({ written_at: WRITTEN_AT + 1 }),
    );
  });
});
