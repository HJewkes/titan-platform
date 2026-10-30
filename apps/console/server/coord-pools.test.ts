import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coordinatorCommands, type CoordinatorSource } from "./coordinator.js";
import type { ConsoleContext } from "./owner-guard.js";

const CTX: ConsoleContext = { warnings: [], format: "json", surface: "in-process", auth: null, ownerWrites: false };
const local = (month: number, day: number, hour: number, minute = 0): number => new Date(2031, month - 1, day, hour, minute).getTime();
const NOW = local(10, 30, 12);
const DAY = 86_400_000;
const RESETS_AT = NOW + 3 * DAY;

const CHARTER = `---
pools:
  claude:
    reserve_seven_day: 14
    per_day_points: 30
  personal:
    reserve_seven_day: 14
    per_day_points: 60
  agents:
    reserve_seven_day: 7
---

# Charter
`;

const PACE = {
  at: NOW,
  pools: {
    claude: { pool: "claude", sevenDay: 55, fiveHour: 30, ageSeconds: 144, stale: false, resetsAt: RESETS_AT, target: 60, behind: 5, needs: 9, level: "behind", members: ["claude", "personal"] },
    agents: { pool: "agents", sevenDay: 40, fiveHour: 1, ageSeconds: 900, stale: true, resetsAt: RESETS_AT, target: 41, behind: 1, needs: 4, level: "on_pace" },
  },
};

const readingLine = (pool: string, ts: number, sevenDay: number): string =>
  JSON.stringify({ ts: ts / 1000, pool, seven_day: sevenDay, five_hour: 0, resets_at: RESETS_AT / 1000, source: "watchdog", age_s: 5 });

let dir: string;
let autonomy: string;
let chat: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "coord-pools-"));
  autonomy = path.join(dir, "autonomy");
  chat = path.join(dir, "chat");
  await mkdir(autonomy);
  await mkdir(chat);
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const source = (overrides: Partial<CoordinatorSource> = {}): CoordinatorSource => ({ roots: { autonomyDir: autonomy, agentChatDir: chat }, dayStart: "07:00", now: () => NOW, ...overrides });
const pools = (coordinator: CoordinatorSource, args: { date?: string } = {}) => coordinatorCommands(coordinator)["coord.pools"].run(args, CTX);

describe("coord.pools", () => {
  it("gives one meter for an account shared by two pools and guards with the smaller per-day limit", async () => {
    await writeFile(path.join(autonomy, "charter.md"), CHARTER);
    await writeFile(path.join(chat, "pace.json"), JSON.stringify(PACE));
    await writeFile(path.join(chat, "pool-readings.jsonl"), [readingLine("claude", local(10, 30, 6, 50), 30), readingLine("claude", local(10, 30, 11), 48)].join("\n"));

    const result = await pools(source());

    expect(result.accounts.map((account) => account.pool)).toEqual(["claude", "agents"]);
    expect(result.accounts[0]).toMatchObject({
      members: ["claude", "personal"], current: 55, beforeToday: 30, today: 25, perDayGuard: 60, target: 60, level: "behind", stale: false, resetsAt: RESETS_AT,
    });
    expect(result.accounts[0]!.error).toBeUndefined();
  });

  it("computes the reserve line from the charter reserve and the day of the window", async () => {
    await writeFile(path.join(autonomy, "charter.md"), CHARTER);
    await writeFile(path.join(chat, "pace.json"), JSON.stringify(PACE));

    const result = await pools(source());

    // Reset in 3 days means day 5 of 7: 100 - 14 * (8 - 5) / 7.
    expect(result.accounts[0]!.reserveLine).toBeCloseTo(94, 5);
    expect(result.accounts[1]!.reserveLine).toBeCloseTo(97, 5);
  });

  it("answers every charter account with an error when pace.json is absent, without throwing", async () => {
    await writeFile(path.join(autonomy, "charter.md"), CHARTER);

    const result = await pools(source());

    expect(result.accounts.map((account) => account.pool)).toEqual(["claude", "personal", "agents"]);
    expect(result.accounts.every((account) => /pace\.json/.test(account.error ?? ""))).toBe(true);
    expect(result.accounts.every((account) => account.current === null && account.perDayGuard === null)).toBe(true);
  });

  it("answers an unparsable pace.json as per-account errors too", async () => {
    await writeFile(path.join(autonomy, "charter.md"), CHARTER);
    await writeFile(path.join(chat, "pace.json"), "{not json");

    const result = await pools(source());

    expect(result.accounts.length).toBe(3);
    expect(result.accounts.every((account) => account.error !== undefined)).toBe(true);
  });

  it("still renders pace.json with the autonomy gap when no autonomy dir is set", async () => {
    await writeFile(path.join(chat, "pace.json"), JSON.stringify(PACE));

    const result = await pools(source({ roots: { autonomyDir: null, agentChatDir: chat } }));

    expect(result.accounts[0]).toMatchObject({ pool: "claude", current: 55, reserveLine: null, perDayGuard: null });
    expect(result.gaps.join("\n")).toMatch(/TITAN_CONSOLE_AUTONOMY_DIR/);
  });

  it("keeps healthy accounts when one pool has no reading", async () => {
    const idle = { pool: "workout", sevenDay: null, fiveHour: null, ageSeconds: null, stale: null, resetsAt: null, target: null, behind: null, needs: null, level: "no_reading" };
    await writeFile(path.join(chat, "pace.json"), JSON.stringify({ at: NOW, pools: { ...PACE.pools, workout: idle } }));

    const result = await pools(source());

    expect(result.accounts.map((account) => [account.pool, account.error === undefined])).toEqual([["claude", true], ["agents", true], ["workout", false]]);
    expect(result.accounts[2]).toMatchObject({ level: "no_reading", current: null });
  });

  it("uses the window of a given date", async () => {
    await writeFile(path.join(chat, "pace.json"), JSON.stringify(PACE));

    const result = await pools(source(), { date: "2031-10-20" });

    expect(result).toMatchObject({ date: "2031-10-20", from: new Date(local(10, 20, 7)).toISOString() });
  });
});
