import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { LIVE_VIEWED_FILE, createDecisionLog } from "./decision-log.js";
import type { ConsoleContext } from "./owner-guard.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { roundsSubmitCommands } from "./rounds-submit.js";
import { buildIdOf } from "./storybook-build.js";
import { STORY_BUILD_FILES, STORY_ROUND_ID } from "./test-support.js";

const NOW = new Date("2026-10-22T09:00:00Z");
const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: SESSION_AUTH, ownerWrites: true };
const ANSWERS = [{ questionId: "density-pick", pick: "compact" }];
const BUILD_FILES = Object.entries(STORY_BUILD_FILES).map(([rel, text]) => ({ path: rel, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) }));
const BUILD_ID = buildIdOf(BUILD_FILES);

let root: string;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const exists = (file: string) => stat(file).then(() => true, () => false);

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

/** Synthetic: the lantern-cards story round with a frames index and, unless `storybook` is false, a storybook@1 sidecar. */
async function storyRound(name: string, storybook = true): Promise<{ dir: string; stateDir: string; manifestSha256: string }> {
  const dir = path.join(root, name, "rounds");
  const roundDir = path.join(dir, STORY_ROUND_ID);
  await cp(path.join(FIXTURE_ROUNDS.dir, STORY_ROUND_ID), roundDir, { recursive: true });
  const frame = (key: string) => ({ key, variant: key, viewport: { width: 390, height: 200 }, file: `shots/${key}.png`, sha256: "0".repeat(64) });
  await writeJson(path.join(roundDir, "frames", "frames.json"), { schema: "titan-review/frames@1", unit: "lantern-cards", round: 1, frames: [frame("compact"), frame("roomy")] });
  const sidecar = { schema: "titan-review/storybook@1", repo: "example-org/example-ui", sha: "a".repeat(40), dirty: false, builtAt: "2026-10-21T00:00:00Z", storybookVersion: "10.0.0", storyIds: 2, files: BUILD_FILES };
  if (storybook) await writeJson(path.join(roundDir, "storybook", "storybook.json"), sidecar);
  return { dir, stateDir: path.join(root, name, "state"), manifestSha256: sha256(await readFile(path.join(roundDir, "round.json"))) };
}

async function submitTo(round: Awaited<ReturnType<typeof storyRound>>, extra: Record<string, unknown> = {}) {
  const decisionLog = createDecisionLog({ stateDir: round.stateDir, decisionsFile: null, humanOnly: async () => ({ known: true, initiatives: new Set<string>() }) });
  const command = roundsSubmitCommands({ dir: round.dir }, decisionLog)["rounds.submit"];
  return invokeCommand(command, { id: STORY_ROUND_ID, manifestSha256: round.manifestSha256, answers: ANSWERS, ...extra }, OWNER);
}

const feedbackBytes = (round: { dir: string }) => readFile(path.join(round.dir, STORY_ROUND_ID, "feedback.json"));
const liveRows = async (round: { stateDir: string }): Promise<unknown[]> =>
  (await readFile(path.join(round.stateDir, LIVE_VIEWED_FILE), "utf8")).trim().split("\n").map((line): unknown => JSON.parse(line));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rounds-submit-live-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("rounds.submit with the variants the owner opened live (TP-3793 S7)", () => {
  it("logs one line with the keys and the build, and writes feedback.json byte-equal to a submit without them", async () => {
    const [withLive, without] = [await storyRound("with-live"), await storyRound("without")];

    const live = await submitTo(withLive, { liveViewed: ["compact"] });
    const plain = await submitTo(without);

    expect(live.envelope).toMatchObject({ ok: true, data: { status: "submitted", liveViewedLog: "written" } });
    expect(await liveRows(withLive)).toEqual([{ v: 1, roundId: STORY_ROUND_ID, at: NOW.toISOString(), keys: ["compact"], buildId: BUILD_ID }]);
    expect((await feedbackBytes(withLive)).equals(await feedbackBytes(without))).toBe(true);
    expect(plain.envelope).toMatchObject({ ok: true, data: { status: "submitted" } });
    expect(plain.envelope).not.toMatchObject({ data: { liveViewedLog: expect.anything() } });
    expect(await exists(path.join(without.stateDir, LIVE_VIEWED_FILE))).toBe(false);
  });

  it("dedupes the keys into the round's own order", async () => {
    const round = await storyRound("dupes");

    await submitTo(round, { liveViewed: ["roomy", "compact", "roomy"] });

    expect(await liveRows(round)).toEqual([expect.objectContaining({ keys: ["compact", "roomy"] })]);
  });

  it("logs a null build for a round that carries no Storybook build", async () => {
    const round = await storyRound("no-build", false);

    await submitTo(round, { liveViewed: ["compact"] });

    expect(await liveRows(round)).toEqual([expect.objectContaining({ keys: ["compact"], buildId: null })]);
  });

  it("refuses a key that is no frame of the round, and writes nothing", async () => {
    const round = await storyRound("unknown");

    const { envelope, exitCode } = await submitTo(round, { liveViewed: ["compact", "spacious"] });

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: 'liveViewed names "spacious", which is no frame in this round' });
    expect(await exists(path.join(round.dir, STORY_ROUND_ID, "feedback.json"))).toBe(false);
    expect(await exists(path.join(round.stateDir, LIVE_VIEWED_FILE))).toBe(false);
  });

  it("refuses more keys than its bound", async () => {
    const round = await storyRound("bound");

    const { exitCode } = await submitTo(round, { liveViewed: Array.from({ length: 201 }, () => "compact") });

    expect(exitCode).not.toBe(EXIT.OK);
    expect(await exists(path.join(round.dir, STORY_ROUND_ID, "feedback.json"))).toBe(false);
  });
});
