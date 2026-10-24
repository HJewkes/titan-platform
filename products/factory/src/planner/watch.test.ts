import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { depositItemId, ownerItemDepositSchema } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { readWithdrawal } from "@titan-design/owner-queue/withdraw";
import { runCli, type CliIo } from "../cli.js";
import { factoryWorkflows } from "../workflows.js";
import { plannerAlarmDeposit } from "./alarm.js";
import type { PlannerRun } from "./inputs.js";

const SPAWNED_AT = Date.parse("2031-03-05T12:00:00Z");

let dir: string;
let clock: number;
let polls: number;
/** What `agent ls --json` reports on each poll; the last entry repeats. */
let roster: unknown[][];
/** Called on each poll before the roster answers, so a test can write a review mid-watch. */
let onPoll: (poll: number) => void;

const run: PlannerRun = async (_file, args) => {
  if (args[1] === "ls" && args[2] === "--json") {
    onPoll(++polls);
    return { code: 0, stdout: JSON.stringify(roster[Math.min(polls, roster.length) - 1]), stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

const inbox = (): string => join(dir, "inbox");
const reviews = (): string => join(dir, "reviews");
const live = (transcriptPath?: string): unknown => ({ name: "factory-planner", presence: "live", transcriptPath: transcriptPath ?? null });

function writeConfig(extra: Record<string, unknown> = {}): string {
  const path = join(dir, "planner.json");
  const config = { cwd: dir, brief: join(reviews(), "brief.md"), reviewDir: reviews(), inputs: [{ name: "brief", file: join(reviews(), "brief.md") }], ...extra };
  writeFileSync(path, JSON.stringify(config));
  return path;
}

async function wake(config = writeConfig()): Promise<{ code: number; out: string }> {
  let out = "";
  const io: CliIo = { stdout: (text) => void (out += text), stderr: (text) => void (out += text), env: { XDG_STATE_HOME: join(dir, "state"), TITAN_CONSOLE_INBOX_DIR: inbox() } };
  const planner = { run, now: () => new Date(clock), sleep: async (ms: number) => void (clock += ms) };
  const code = await runCli(["planner", "wake", "--config", config], io, { workflows: factoryWorkflows, routes: [], planner });
  return { code, out };
}

function deposits(): ReturnType<typeof ownerItemDepositSchema.parse>[] {
  const names = readdirSync(inbox()).filter((name) => name.endsWith(".json"));
  return names.map((name) => ownerItemDepositSchema.parse(JSON.parse(readFileSync(join(inbox(), name), "utf8"))));
}

function review(name: string, mtimeMs: number): void {
  const path = join(reviews(), name);
  writeFileSync(path, "# Review\n");
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "planner-watch-"));
  clock = SPAWNED_AT;
  polls = 0;
  roster = [[live()]];
  onPoll = () => {};
  mkdirSync(reviews());
  mkdirSync(inbox());
  review("brief.md", SPAWNED_AT + 1);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("titan-factory planner wake waits for the review", () => {
  it("a planner that exits without writing a review files one inbox deposit carrying its API error", async () => {
    const transcript = join(dir, "session.jsonl");
    const limit = { isApiErrorMessage: true, apiError: "usage_limit_reached", apiErrorParams: { rate_limit_info: { resetsAt: 1931000000 } }, message: { content: [{ type: "text", text: "You've hit your weekly limit" }] } };
    writeFileSync(transcript, `${JSON.stringify({ type: "user" })}\n${JSON.stringify(limit)}\n`);
    roster = [[live(transcript)], []];

    const { code, out } = await wake();

    expect(code).toBe(1);
    expect(polls).toBe(2);
    const [deposit, ...rest] = deposits();
    expect(rest).toEqual([]);
    expect(deposit!.summary).toBe("factory-planner wake wrote no review (exited: You've hit your weekly limit)");
    expect(deposit!.context).toContain("API error usage_limit_reached: You've hit your weekly limit. Resets at 2031-03-11T12:53:20.000Z.");
    expect(deposit!.keys).toEqual(["planner-alarm", "alarm:planner-alarm:factory-planner"]);
    expect(out).toMatch(/no review: factory-planner wake wrote no review/);
  });

  it("a planner still running with no review after 30 minutes files the alarm", async () => {
    const { code } = await wake();

    expect(code).toBe(1);
    expect(clock).toBe(SPAWNED_AT + 30 * 60_000);
    expect(polls).toBe(31);
    expect(deposits().map((deposit) => deposit.summary)).toEqual(["factory-planner wake wrote no review (still running after 30 min)"]);
  });

  it("a review file newer than the spawn ends the watch and withdraws an open planner alarm", async () => {
    const earlier = plannerAlarmDeposit({ name: "factory-planner", reason: "exited", spawnedAt: "2031-03-05T09:00:00.000Z", noFileAfterMinutes: 30, reviewDir: reviews() });
    await writeDeposit(inbox(), earlier);
    onPoll = (poll) => poll === 2 && review("2031-03-05-1200.md", clock);

    const { code, out } = await wake();

    expect(code).toBe(0);
    expect(polls).toBe(2);
    expect(out).toMatch(/wrote 2031-03-05-1200\.md/);
    expect(await readWithdrawal(inbox(), depositItemId("titan-factory", earlier.depositId))).toMatchObject({ reason: "resolved", by: "titan-factory" });
    expect(deposits()).toHaveLength(1);
  });

  it("a review file older than the spawn, or the brief beside the reviews, does not count", async () => {
    review("2031-03-05-0900.md", SPAWNED_AT - 60_000);
    roster = [[]];

    const { code } = await wake();

    expect(code).toBe(1);
    expect(deposits().map((deposit) => deposit.summary)).toEqual(["factory-planner wake wrote no review (exited)"]);
  });

  it("a config whose configDir is the personal profile is refused", async () => {
    const { code, out } = await wake(writeConfig({ configDir: join(dir, ".claude-profiles", "personal") }));

    expect(code).toBe(1);
    expect(out).toMatch(/configDir is the owner's personal account/);
    expect(polls).toBe(0);
  });
});
