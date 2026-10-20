import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "@titan-design/registry";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { fileRound } from "./round-file.js";

// Synthetic fixtures: kiln-schedule-r2 asks questions only; lantern-cards-r1 has variants; orbit-retry-r1 is a Ship.
const QUESTIONS_ONLY = "kiln-schedule-r2";
const ASKER = { seat: "sample-seat", initiative: "sample-initiative" };
const NOW = new Date("2026-10-20T12:00:00.000Z");

let root: string;
let roundsDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-round-file-"));
  roundsDir = path.join(root, "rounds");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const fixture = (id: string): Promise<string> => readFile(path.join(FIXTURE_ROUNDS.dir, id, "round.json"), "utf8");
const entries = (dir: string) => readdir(dir).catch(() => []);

describe("filing a decision round", () => {
  it("lands round.json and an asker record under the rounds dir, as <unit>-r<round>", async () => {
    const body = await fixture(QUESTIONS_ONLY);

    const result = await fileRound({ body, roundsDir, asker: ASKER, now: NOW });

    expect(result).toEqual({ id: QUESTIONS_ONLY, created: true, ...ASKER });
    expect(await entries(roundsDir)).toEqual([QUESTIONS_ONLY]);
    expect((await entries(path.join(roundsDir, QUESTIONS_ONLY))).sort()).toEqual(["asker.json", "round.json"]);
    expect(await readFile(path.join(roundsDir, QUESTIONS_ONLY, "round.json"), "utf8")).toBe(body);
    expect(JSON.parse(await readFile(path.join(roundsDir, QUESTIONS_ONLY, "asker.json"), "utf8"))).toEqual({
      schema: "titan-console/asker@1",
      ...ASKER,
      filedAt: NOW.toISOString(),
    });
    expect((await stat(path.join(roundsDir, QUESTIONS_ONLY, "asker.json"))).mode & 0o777).toBe(0o600);
  });

  it("records a seat with no initiative", async () => {
    const result = await fileRound({ body: await fixture(QUESTIONS_ONLY), roundsDir, asker: { seat: "second-seat", initiative: null } });

    expect(result).toMatchObject({ seat: "second-seat", initiative: null });
  });

  it("leaves no copy of the round in the temp dir it files through", async () => {
    const privateTmp = path.join(root, "tmp");
    await mkdir(privateTmp);
    vi.stubEnv("TMPDIR", privateTmp);

    await fileRound({ body: await fixture(QUESTIONS_ONLY), roundsDir, asker: ASKER });

    expect(await readdir(privateTmp)).toEqual([]);
  });

  it("keeps the first asker when the same round.json is filed again", async () => {
    const body = await fixture(QUESTIONS_ONLY);
    await fileRound({ body, roundsDir, asker: ASKER });

    const again = await fileRound({ body, roundsDir, asker: { seat: "other-seat", initiative: null } });

    expect(again).toEqual({ id: QUESTIONS_ONLY, created: false, ...ASKER });
  });

  it("refuses a different round.json under an id already filed", async () => {
    await fileRound({ body: await fixture(QUESTIONS_ONLY), roundsDir, asker: ASKER });
    const changed = (await fixture(QUESTIONS_ONLY)).replace("second pass after the ramp rework", "a changed context line");

    await expect(fileRound({ body: changed, roundsDir, asker: ASKER })).rejects.toThrow(/already imported with a different round\.json/);
  });
});

describe("a decision round that is refused writes nothing", () => {
  it.each([
    ["text that is not JSON", async () => "not json", /round\.json: round\.json is not JSON/],
    ["a round@1 manifest", () => fixture("legacy-r1"), /predates the review contract/],
    ["a round with variants", () => fixture("lantern-cards-r1"), /asks questions only, and this one has 2 variants; .*rounds import/],
    ["a merge-bound Ship", () => fixture("orbit-retry-r1"), /asks questions only, and question \S+ is a merge-bound Ship/],
  ])("refuses %s", async (_label, body, message) => {
    const run = fileRound({ body: await body(), roundsDir, asker: ASKER });

    await expect(run).rejects.toMatchObject({ code: EXIT.DATAERR, message: expect.stringMatching(/^decision round refused: /) });
    await expect(run).rejects.toThrow(message);
    expect(await entries(roundsDir)).toEqual([]);
  });

  it.each([
    ["a seat that is not an agent-chat name", { seat: "Bad Seat", initiative: null }],
    ["an initiative that is not a slug", { seat: "sample-seat", initiative: "../x" }],
  ])("refuses %s as a usage error", async (_label, asker) => {
    await expect(fileRound({ body: await fixture(QUESTIONS_ONLY), roundsDir, asker })).rejects.toMatchObject({ code: EXIT.USAGE });
    expect(await entries(roundsDir)).toEqual([]);
  });
});
