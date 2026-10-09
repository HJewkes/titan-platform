import { cp, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import { EXIT } from "@titan-design/registry";
import { resolveConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import { MAX_ROUND_BYTES, getRound, listRounds, roundsCommands, type RoundDetail, type RoundSummary } from "./rounds.js";
import { closedPort, send } from "./test-support.js";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "rounds");

let root: string;
let dir: string;

/** Oldest first, so the newest-first order is known without reading the fixture copy times. */
const AGE_ORDER = ["legacy-r1", "unreadable-r1", "kiln-schedule-r1", "lantern-cards-r1", "orbit-retry-r1", "kiln-schedule-r2"];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-rounds-"));
  dir = path.join(root, "rounds");
  await cp(FIXTURES, dir, { recursive: true });
  await Promise.all(AGE_ORDER.map((id, index) => utimes(path.join(dir, id, "round.json"), 2_000_000_000 + index, 2_000_000_000 + index)));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const summaryOf = (rounds: readonly RoundSummary[], id: string): RoundSummary | undefined => rounds.find((round) => round.id === id);

function validDetail(detail: RoundDetail): Extract<RoundDetail, { valid: true }> {
  if (!detail.valid) throw new Error(`expected a valid round, got: ${detail.reason}`);
  return detail;
}

describe("rounds.list", () => {
  it("lists every round newest first, open or sent by whether feedback sits beside it", async () => {
    const { rounds, truncated } = await listRounds({ dir });

    expect(rounds.map((round) => round.id)).toEqual([...AGE_ORDER].reverse());
    expect(rounds.map((round) => [round.id, round.status])).toContainEqual(["kiln-schedule-r1", "sent"]);
    expect(rounds.filter((round) => round.status === "sent")).toHaveLength(1);
    expect(truncated).toBe(false);
  });

  it("summarizes a valid round and marks one with frames as a design round", async () => {
    const { rounds } = await listRounds({ dir });

    expect(summaryOf(rounds, "kiln-schedule-r2")).toMatchObject({ valid: true, unit: "kiln-schedule", round: 2, questions: 4, design: false, recommendations: "after-answer" });
    expect(summaryOf(rounds, "lantern-cards-r1")).toMatchObject({ valid: true, design: true });
  });

  it("lists a round@1 manifest as invalid with the schema's own reason", async () => {
    const legacy = summaryOf((await listRounds({ dir })).rounds, "legacy-r1");

    expect(legacy).toMatchObject({ valid: false, status: "open" });
    expect(legacy?.valid === false && legacy.reason).toMatch(/^schema: titan-review\/round@1 predates the review contract/);
  });

  it("lists a round.json that is not JSON as invalid", async () => {
    expect(summaryOf((await listRounds({ dir })).rounds, "unreadable-r1")).toMatchObject({ valid: false, reason: "round.json is not JSON" });
  });

  it("answers an empty list when the rounds dir does not exist yet", async () => {
    expect(await listRounds({ dir: path.join(root, "missing") })).toEqual({ rounds: [], truncated: false });
  });
});

describe("rounds.get", () => {
  it("strips every recommendation from an unsent after-answer round", async () => {
    const detail = validDetail(await getRound({ dir }, "kiln-schedule-r2"));

    expect(detail.recommendationsWithheld).toBe(true);
    expect(detail.manifest.questions).toHaveLength(4);
    for (const question of detail.manifest.questions) expect(question).not.toHaveProperty("recommendation");
  });

  it("keeps recommendations once an after-answer round is sent", async () => {
    const detail = validDetail(await getRound({ dir }, "kiln-schedule-r1"));

    expect(detail.status).toBe("sent");
    expect(detail.recommendationsWithheld).toBe(false);
    expect(detail.manifest.questions[0]).toHaveProperty("recommendation.answer", "Celsius");
  });

  it("keeps recommendations in a round that shows them", async () => {
    const detail = validDetail(await getRound({ dir }, "orbit-retry-r1"));

    expect(detail.recommendationsWithheld).toBe(false);
    expect(detail.manifest.questions[0]).toHaveProperty("recommendation.answer", "Ship");
  });

  it("flags a design round and passes its loopback Storybook address", async () => {
    expect(validDetail(await getRound({ dir }, "lantern-cards-r1"))).toMatchObject({ design: true, storybookUrl: "http://127.0.0.1:6006" });
  });

  it("answers an invalid round with its reason rather than failing", async () => {
    expect(await getRound({ dir }, "unreadable-r1")).toMatchObject({ id: "unreadable-r1", valid: false, reason: "round.json is not JSON" });
  });

  it.each(["..", "../rounds/kiln-schedule-r2", "kiln-schedule-r2/../kiln-schedule-r1", "nowhere", ".hidden"])("refuses %j as no round", async (id) => {
    await expect(getRound({ dir }, id)).rejects.toMatchObject({ code: EXIT.NOINPUT });
  });
});

describe("the rounds dir defences", () => {
  async function outsideRound(): Promise<string> {
    const outside = path.join(root, "outside");
    await cp(path.join(FIXTURES, "kiln-schedule-r2"), outside, { recursive: true });
    return outside;
  }

  it("neither lists nor serves a round directory that is a symlink", async () => {
    await symlink(await outsideRound(), path.join(dir, "linked-r1"));

    expect(summaryOf((await listRounds({ dir })).rounds, "linked-r1")).toBeUndefined();
    await expect(getRound({ dir }, "linked-r1")).rejects.toMatchObject({ code: EXIT.NOINPUT });
  });

  it("refuses a round.json that is a symlink", async () => {
    const outside = await outsideRound();
    await mkdir(path.join(dir, "pointer-r1"));
    await symlink(path.join(outside, "round.json"), path.join(dir, "pointer-r1", "round.json"));

    expect(await getRound({ dir }, "pointer-r1")).toMatchObject({ valid: false, reason: "round.json is a symlink" });
  });

  it("refuses a round.json over the size cap without parsing it", async () => {
    await mkdir(path.join(dir, "huge-r1"));
    await writeFile(path.join(dir, "huge-r1", "round.json"), " ".repeat(MAX_ROUND_BYTES + 1));

    expect(await getRound({ dir }, "huge-r1")).toMatchObject({ valid: false, reason: `round.json is over ${MAX_ROUND_BYTES} bytes` });
  });

  it("does not count a symlinked feedback.json as sent", async () => {
    await symlink(path.join(dir, "kiln-schedule-r1", "feedback.json"), path.join(dir, "kiln-schedule-r2", "feedback.json"));

    expect(validDetail(await getRound({ dir }, "kiln-schedule-r2"))).toMatchObject({ status: "open", recommendationsWithheld: true });
  });

  it("classes both commands as reads", () => {
    const commands = roundsCommands({ dir });
    expect([commands["rounds.list"].commandClass, commands["rounds.get"].commandClass]).toEqual(["read", "read"]);
  });
});

describe("rounds.get over the daemon's RPC", () => {
  let handle: DaemonHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("returns an unsent after-answer round with no recommendation in the reply body", async () => {
    const closed = String(await closedPort());
    const env = { TITAN_CONSOLE_STATE: path.join(root, "state"), TITAN_CONSOLE_PORT: "0", TITAN_CONSOLE_ROUNDS_DIR: dir, TITAN_CONSOLE_ACTIVE_WORK_PORT: closed, TITAN_CONSOLE_AGENT_CHAT_PORT: closed };
    handle = await startConsoleDaemon({ config: resolveConfig(env, root), logger: silentLogger });
    const host = `127.0.0.1:${handle.port}`;

    const reply = await send("127.0.0.1", handle.port, "POST", "/rpc/rounds.get", { host, "content-type": "application/json", "x-titan-client": "test" }, JSON.stringify({ id: "kiln-schedule-r2" }));

    expect(reply.status).toBe(200);
    expect(reply.body).not.toContain("recommendation\"");
    expect(reply.body).not.toContain("Staged climbs cracked fewer");
    expect(JSON.parse(reply.body)).toMatchObject({ ok: true, data: { id: "kiln-schedule-r2", recommendationsWithheld: true } });
  });
});
