import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIST_PRICE_CAVEAT } from "@titan-design/session-analytics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { seedEventsDb, type FixtureMessage } from "./fixture.js";
import type { RoundTripsReport } from "./round-trips.js";

const HEAD = "a".repeat(40);
const WINDOW = ["--since", "2026-09-12", "--until", "2026-09-13"];
const at = (hour: number) => `2026-09-12T${String(hour).padStart(2, "0")}:00:00Z`;
const send = (ts: string, actor: string, target: string, body: string): FixtureMessage => ({ ts, actor, target, body });
const verdict = (word: string, pr: string | null) => [`Verdict: ${word}`, ...(pr ? [`PR: ${pr}`] : []), `Head: ${HEAD}`, "", "Blocking: none."].join("\n");

const EVENTS: FixtureMessage[] = [
  { kind: "agent_spawned", ts: "2026-09-11T12:00:00Z", actor: "coord-a", target: "impl-a", body: "" },
  send(at(10), "coord-a", "impl-a", "Brief update: the PR goes to the fix/widgets branch."),
  send(at(11), "coord-a", "impl-a", "Any update on the widgets PR?"),
  send(at(12), "coord-a", "impl-a", "Stop, do not push until the reviewer answers."),
  send(at(13), "coord-a", "impl-a", "Here are the reviewer's notes for the widgets PR."),
  send(at(13), "impl-a", "coord-a", "Status: DONE\nPR: acme/widgets#2. Stop here, I was wrong earlier."),
  send(at(13), "rev-1", "impl-a", "Stop, do not merge yet."),
  send(at(10), "rev-1", "coord-a", verdict("MERGE", "acme/widgets#1")),
  send(at(10), "rev-1", "coord-a", verdict("FIX_FIRST", "acme/widgets#2")),
  send(at(14), "rev-1", "coord-a", verdict("MERGE", "https://github.com/acme/widgets/pull/2")),
  send(at(14), "rev-1", "coord-a", verdict("MERGE", null)),
  send("2026-09-13T12:00:00Z", "coord-a", "impl-a", "Any update?"),
  send("2026-09-13T12:00:00Z", "rev-1", "coord-a", verdict("FIX_FIRST", "acme/widgets#1")),
];

let dir: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-round-trips-"));
  env = { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), EVENTS) };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env };
  const code = await runCli(["--state", path.join(dir, "state"), "--corpus", path.join(dir, "corpus"), ...args], io);
  return { code, stdout };
}

async function ask(): Promise<RoundTripsReport> {
  const { code, stdout } = await cli(["--json", "insights", "round-trips", ...WINDOW]);
  expect(code).toBe(0);
  const data = (JSON.parse(stdout) as { data: { question: string; caveat: string; answer: RoundTripsReport } }).data;
  expect(data).toMatchObject({ question: "Q6", caveat: LIST_PRICE_CAVEAT });
  return data.answer;
}

describe("insights round-trips (Q6)", () => {
  it.each([
    ["brief-fix", "a brief update"],
    ["poll", "a status ask"],
    ["correction", "a stop"],
    ["other", "plain notes"],
  ] as const)("classes a parent's follow-up to its child as %s (%s)", async (cls, _what) => {
    const answer = await ask();

    expect(answer.followUps).toContainEqual({ day: "2026-09-12", class: cls, count: 1 });
  });

  it("counts only messages from an agent's spawner, inside the window", async () => {
    const answer = await ask();

    expect(answer.totals.followUps).toBe(4);
  });

  it("counts a FIX_FIRST then MERGE PR as one FIX_FIRST round and one re-review, across # and URL PR lines", async () => {
    const answer = await ask();

    expect(answer.prs).toEqual([
      { pr: "acme/widgets#1", verdicts: ["MERGE"], fixFirstRounds: 0, reReviews: 0, firstPassMerge: true, firstDay: "2026-09-12" },
      { pr: "acme/widgets#2", verdicts: ["FIX_FIRST", "MERGE"], fixFirstRounds: 1, reReviews: 1, firstPassMerge: false, firstDay: "2026-09-12" },
    ]);
  });

  it("counts a verdict missing its PR line toward its day and no PR", async () => {
    const answer = await ask();

    expect(answer.verdictDays).toEqual([{ day: "2026-09-12", verdicts: 4, withoutPrLine: 1, firstVerdicts: 2, firstPassMerges: 1 }]);
    expect(answer.totals).toMatchObject({ verdicts: 4, verdictsWithoutPrLine: 1, prs: 2, firstPassMerges: 1 });
  });

  it.each([
    ["--session", ["--session", "impl-1"]],
    ["--agent-prefix", ["--agent-prefix", "impl-"]],
    ["--role", ["--role", "coordinator"]],
  ])("refuses %s, which it cannot honour", async (_flag, flags) => {
    const { code, stdout } = await cli(["--json", "insights", "round-trips", ...flags]);

    expect(code).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/round-trips does not take/) });
  });

  it("prints its tables with the list-price caveat", async () => {
    const { code, stdout } = await cli(["insights", "round-trips", ...WINDOW]);

    expect(code).toBe(0);
    expect(stdout).toContain("| acme/widgets#2 | FIX_FIRST MERGE | 1 | 1 |");
    expect(stdout).toContain(LIST_PRICE_CAVEAT);
  });
});
