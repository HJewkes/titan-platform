import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW } from "../fixtures/fake-tokens.js";
import { makeTempHome, removeTempHome } from "../fixtures/temp-home.js";
import { sessionsDir } from "../node/usage-file.js";
import { runCli } from "./cli.js";
import { UNKNOWN_LINE } from "./statusline.js";

const SECONDS = Math.floor(NOW / 1000);
const DAY = 86_400;

let home: string;
let stdout: string[];

beforeEach(() => {
  home = makeTempHome();
  stdout = [];
});

afterEach(() => removeTempHome(home));

const dir = (label: string): string => path.join(home, ".claude-profiles", label);

type Windows = Record<string, { used_percentage: number; resets_at?: number }>;

function writeSession(label: string, file: string, ageSeconds: number, rateLimits: Windows): void {
  fs.mkdirSync(sessionsDir(dir(label)), { recursive: true });
  const reading = { session_id: file.replace(/\.json$/, ""), written_at: SECONDS - ageSeconds, rate_limits: rateLimits };
  fs.writeFileSync(path.join(sessionsDir(dir(label)), file), JSON.stringify(reading));
}

async function statusline(label: string): Promise<string[]> {
  const context = { env: { CLAUDE_CONFIG_DIR: dir(label) }, home, now: () => NOW, uid: process.getuid?.() ?? 0 };
  await runCli(["status", "--statusline"], { ...context, out: (line) => stdout.push(line), err: () => undefined } as never);
  return stdout;
}

const weekly = (used: number, resetsIn = 3 * DAY): Windows => ({ seven_day: { used_percentage: used, resets_at: SECONDS + resetsIn } });
const both = (five: number, used: number): Windows => ({
  five_hour: { used_percentage: five, resets_at: SECONDS + 3600 },
  seven_day: { used_percentage: used, resets_at: SECONDS + 3 * DAY },
});

describe("status --statusline without five_hour", () => {
  it("prefers a fresh seven_day-only poller file over a 2-day-old session file with both windows", async () => {
    writeSession("agents", "usage-poll.json", 60, weekly(19));
    writeSession("agents", "session-a.json", 2 * DAY, both(50, 85));

    expect(await statusline("agents")).toEqual([`|19||${SECONDS + 3 * DAY}|||||60`]);
  });

  it("falls back to a newer session file once the poller file is older than 360 seconds", async () => {
    writeSession("agents", "usage-poll.json", 361, weekly(19));
    writeSession("agents", "session-a.json", 10, both(50, 30));

    expect(await statusline("agents")).toEqual([`50|30|${SECONDS + 3600}|${SECONDS + 3 * DAY}|||||10`]);
  });

  it("prints unknown when every reading's seven_day window has already reset", async () => {
    writeSession("agents", "usage-poll.json", 60, weekly(19, -10));
    writeSession("agents", "session-a.json", 2 * DAY, both(50, 85));
    fs.rmSync(path.join(sessionsDir(dir("agents")), "session-a.json"));
    writeSession("agents", "session-b.json", 2 * DAY, { ...both(50, 85), seven_day: { used_percentage: 85, resets_at: SECONDS - DAY } });

    expect(await statusline("agents")).toEqual([UNKNOWN_LINE]);
  });

  it("leaves the 5h field empty in the current line and in the other| line", async () => {
    const context = { env: { CLAUDE_CONFIG_DIR: dir("agents") }, home, now: () => NOW, uid: process.getuid?.() ?? 0 };
    writeSession("agents", "usage-poll.json", 60, weekly(21));
    writeSession("workout", "usage-poll.json", 90, weekly(33));

    await runCli(["status", "--statusline"], { ...context, out: (line: string) => stdout.push(line), err: () => undefined } as never);

    expect(stdout).toEqual([`|21||${SECONDS + 3 * DAY}|||||60`, "other|workout||33|90|"]);
  });

  it("keeps the line byte-identical when both windows are present", async () => {
    writeSession("agents", "usage-poll.json", 30, both(23.9, 41.5));

    expect(await statusline("agents")).toEqual([`23|41|${SECONDS + 3600}|${SECONDS + 3 * DAY}|||||30`]);
  });
});
