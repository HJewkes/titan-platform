import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { getFrame } from "./round-frames.js";
import { importRound } from "./round-import.js";
import { listRounds } from "./rounds.js";

// Synthetic: the round@2 shape a review-harness build writes, with generated PNGs and invented prose.
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "import", "sample-batch-r2");
const ID = "sample-batch-r2";
const LISTED = ["frames/card-light.png", "frames/card-dark.png", "frames/base/card-light.png", "frames/diff/card-light.png"] as const;

let root: string;
let source: string;
let roundsDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-round-import-"));
  source = path.join(root, "harness", "round-2");
  roundsDir = path.join(root, "state", "rounds");
  await cp(FIXTURE, source, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const runImport = (from = source) => importRound({ source: from, roundsDir });
const entries = (dir = roundsDir) => readdir(dir).catch(() => []);
const jsonObject = z.record(z.string(), z.unknown());
const readJson = async (file: string) => jsonObject.parse(JSON.parse(await readFile(file, "utf8")));

async function expectRefused(message: RegExp, from = source): Promise<void> {
  await expect(runImport(from)).rejects.toMatchObject({ message: expect.stringMatching(message) });
}

async function editJson(rel: string, edit: (json: Record<string, unknown>) => void): Promise<void> {
  const json = await readJson(path.join(source, rel));
  edit(json);
  await writeFile(path.join(source, rel), JSON.stringify(json));
}

const frameRecords = z.array(z.looseObject({ key: z.string(), file: z.string(), sha256: z.string(), base: z.looseObject({ file: z.string() }).optional() }));
type FrameRecord = z.infer<typeof frameRecords>[number];

/** The fixture lists card-light (with base and diff) and then card-dark. */
async function editFrames(edit: (frames: FrameRecord[], light: FrameRecord, dark: FrameRecord) => void): Promise<void> {
  await editJson("frames/frames.json", (json) => {
    const frames = frameRecords.parse(json.frames);
    const [light, dark] = frames;
    if (light === undefined || dark === undefined) throw new Error("the fixture lists two frames");
    edit(frames, light, dark);
    json.frames = frames;
  });
}

/** Points frames.json and feedback.json at the source's current round.json bytes. */
async function rebind(): Promise<void> {
  const manifestSha256 = sha256Of(await readFile(path.join(source, "round.json")));
  await editJson("frames/frames.json", (json) => (json.manifestSha256 = manifestSha256));
  await editJson("feedback.json", (json) => (json.manifestSha256 = manifestSha256));
}

describe("importRound copies a round@2 dir into the rounds dir", () => {
  it("lands round.json, the listed frames and feedback.json, and the console lists the round valid and sent", async () => {
    await writeFile(path.join(source, "frames", "unlisted.png"), await readFile(path.join(source, "frames", "card-dark.png")));

    const result = await runImport();

    expect(result).toEqual({ id: ID, created: true, frames: 4, feedback: "copied" });
    const dest = path.join(roundsDir, ID);
    expect(await readFile(path.join(dest, "round.json"))).toEqual(await readFile(path.join(source, "round.json")));
    for (const rel of LISTED) expect(await readFile(path.join(dest, rel))).toEqual(await readFile(path.join(source, rel)));
    expect(await entries(path.join(dest, "frames"))).not.toContain("unlisted.png");
    expect(await readFile(path.join(dest, "frames", "frames.json"))).toEqual(await readFile(path.join(source, "frames", "frames.json")));
    expect(await readFile(path.join(dest, "feedback.json"))).toEqual(await readFile(path.join(source, "feedback.json")));
    const { rounds } = await listRounds({ dir: roundsDir });
    expect(rounds).toEqual([expect.objectContaining({ id: ID, valid: true, status: "sent", unit: "sample-batch", round: 2 })]);
  });

  it("creates the rounds dir 0700 and the files 0600, with no staging dir left", async () => {
    await runImport();

    expect((await stat(roundsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(roundsDir, ID, "round.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(roundsDir, ID, LISTED[2]))).mode & 0o777).toBe(0o600);
    expect(await entries()).toEqual([ID]);
  });

  it("serves an imported frame's diff view through rounds.frame", async () => {
    await runImport();

    const read = await getFrame({ dir: roundsDir }, ID, "card-light", "diff");

    expect(read.sha256).toBe(sha256Of(await readFile(path.join(source, "frames", "diff", "card-light.png"))));
  });

  it("imports a round with no frames index and no feedback", async () => {
    await rm(path.join(source, "frames"), { recursive: true });
    await rm(path.join(source, "feedback.json"));

    expect(await runImport()).toEqual({ id: ID, created: true, frames: 0, feedback: "none" });
    expect((await listRounds({ dir: roundsDir })).rounds).toEqual([expect.objectContaining({ id: ID, valid: true, status: "open" })]);
  });
});

describe("importRound re-imports the same round", () => {
  it("changes nothing on a second import of the same dir", async () => {
    await runImport();
    const dest = path.join(roundsDir, ID);
    const files = ["round.json", "feedback.json", "frames/frames.json", ...LISTED];
    const before = await Promise.all(files.map(async (rel) => (await stat(path.join(dest, rel))).mtimeMs));

    const result = await runImport();

    expect(result).toEqual({ id: ID, created: false, frames: 4, feedback: "kept" });
    expect(await Promise.all(files.map(async (rel) => (await stat(path.join(dest, rel))).mtimeMs))).toEqual(before);
    expect(await entries()).toEqual([ID]);
  });

  it("adds a listed frame the destination lacks", async () => {
    await runImport();
    await rm(path.join(roundsDir, ID, LISTED[1]));

    await runImport();

    expect(await readFile(path.join(roundsDir, ID, LISTED[1]))).toEqual(await readFile(path.join(source, LISTED[1])));
  });

  it("keeps a feedback.json the owner wrote in the destination", async () => {
    await rm(path.join(source, "feedback.json"));
    await runImport();
    const owners = Buffer.from('{"written":"by the console"}\n');
    await writeFile(path.join(roundsDir, ID, "feedback.json"), owners);
    await cp(path.join(FIXTURE, "feedback.json"), path.join(source, "feedback.json"));

    expect((await runImport()).feedback).toBe("kept");
    expect(await readFile(path.join(roundsDir, ID, "feedback.json"))).toEqual(owners);
  });

  it("copies feedback.json into an imported round that has none", async () => {
    const feedback = await readFile(path.join(source, "feedback.json"));
    await rm(path.join(source, "feedback.json"));
    await runImport();
    await writeFile(path.join(source, "feedback.json"), feedback);

    expect((await runImport()).feedback).toBe("copied");
    expect(await readFile(path.join(roundsDir, ID, "feedback.json"))).toEqual(feedback);
  });

  it("refuses a round.json that differs by one byte and keeps the original", async () => {
    await runImport();
    const original = await readFile(path.join(roundsDir, ID, "round.json"));
    await writeFile(path.join(source, "round.json"), `${original.toString("utf8")} `);
    await rebind();

    await expectRefused(/already imported with a different round\.json; build round 3/);
    expect(await readFile(path.join(roundsDir, ID, "round.json"))).toEqual(original);
  });

  it("refuses a frames.json that differs from the imported one and keeps the original", async () => {
    await runImport();
    const original = await readFile(path.join(roundsDir, ID, "frames", "frames.json"));
    await editFrames((frames) => frames.pop());

    await expectRefused(/already imported with a different frames\.json/);
    expect(await readFile(path.join(roundsDir, ID, "frames", "frames.json"))).toEqual(original);
  });

  it("refuses an empty dir already at the round's name rather than merging into it", async () => {
    await mkdir(path.join(roundsDir, ID), { recursive: true });

    await expectRefused(/exists without a round\.json/);
    expect(await entries(path.join(roundsDir, ID))).toEqual([]);
  });

  it("refuses a symlink at the round's name in the rounds dir", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(roundsDir, { recursive: true });
    await symlink(elsewhere, path.join(roundsDir, ID));

    await expectRefused(/is a symlink or not a directory/);
    expect(await entries(elsewhere)).toEqual([]);
  });
});

describe("importRound refuses a symlink in the source and writes nothing", () => {
  const cases: [string, string][] = [
    ["the source dir", ""],
    ["round.json", "round.json"],
    ["the frames dir", "frames"],
    ["frames.json", "frames/frames.json"],
    ["a listed frame", "frames/card-dark.png"],
    ["a listed base frame", "frames/base/card-light.png"],
    ["feedback.json", "feedback.json"],
  ];

  it.each(cases)("refuses a symlinked %s", async (_name, rel) => {
    const real = path.join(root, "real");
    await cp(path.join(source, rel), real, { recursive: true });
    await rm(path.join(source, rel), { recursive: true });
    await symlink(real, path.join(source, rel));

    await expect(runImport()).rejects.toMatchObject({ message: expect.stringMatching(/refused/) });
    expect(await entries()).toEqual([]);
  });
});

describe("importRound refuses a frames index it cannot trust and writes nothing", () => {
  const edits: [string, (frames: FrameRecord[], light: FrameRecord, dark: FrameRecord) => void][] = [
    ["a path back up to round.json", (_frames, light) => (light.file = "frames/../round.json")],
    ["a path out of the round", (_frames, light) => (light.file = "../x.png")],
    ["a path out of the round through frames/", (_frames, light) => (light.file = "frames/../../x.png")],
    ["an absolute path", (_frames, light) => (light.file = path.join(root, "harness", "round-2", "frames", "card-light.png"))],
    ["a sha256 that does not match", (_frames, _light, dark) => (dark.sha256 = "0".repeat(64))],
    ["a base sha256 that does not match", (_frames, light) => (light.base = { ...light.base, file: "frames/card-dark.png" })],
    ["a repeated frame key", (frames, _light, dark) => frames.push({ ...dark })],
    ["one file with two sha256s", (frames, _light, dark) => frames.push({ ...dark, key: "card-dark-again", file: LISTED[0] })],
    ["a missing file", (_frames, _light, dark) => (dark.file = "frames/gone.png")],
  ];

  it.each(edits)("refuses %s", async (_name, edit) => {
    await editFrames(edit);

    await expectRefused(/refused/);
    expect(await entries()).toEqual([]);
  });

  const bindings: [string, (json: Record<string, unknown>) => void, RegExp][] = [
    ["a manifestSha256 that is not the round.json hash", (json) => (json.manifestSha256 = "0".repeat(64)), /sha256 of this round\.json/],
    ["no manifestSha256", (json) => delete json.manifestSha256, /sha256 of this round\.json/],
    ["another unit", (json) => (json.unit = "other-batch"), /for another round/],
    ["another round number", (json) => (json.round = 3), /for another round/],
    ["a non-frames@1 schema", (json) => (json.schema = "titan-review/frames@2"), /not a frames@1 index/],
  ];

  it.each(bindings)("refuses a frames.json with %s", async (_name, edit, message) => {
    await editJson("frames/frames.json", edit);

    await expectRefused(message);
    expect(await entries()).toEqual([]);
  });
});

describe("importRound refuses a round or an answer file the console would not read", () => {
  it("refuses a feedback.json for another round.json", async () => {
    await editJson("feedback.json", (json) => (json.manifestSha256 = "f".repeat(64)));

    await expect(runImport()).rejects.toMatchObject({ code: EXIT.DATAERR, message: expect.stringMatching(/answers another round\.json/) });
    expect(await entries()).toEqual([]);
  });

  it("refuses a feedback.json that is not feedback@1, with the schema's reason", async () => {
    await editJson("feedback.json", (json) => delete json.submittedAt);

    await expectRefused(/feedback\.json: submittedAt/);
    expect(await entries()).toEqual([]);
  });

  it("refuses a round@1 round.json with the schema's reason", async () => {
    await cp(path.join(FIXTURE_ROUNDS.dir, "legacy-r1", "round.json"), path.join(source, "round.json"));

    await expect(runImport()).rejects.toMatchObject({ code: EXIT.DATAERR, message: expect.stringMatching(/^import refused: round\.json: schema/) });
    expect(await entries()).toEqual([]);
  });

  it("refuses a round.json that is not JSON", async () => {
    await writeFile(path.join(source, "round.json"), "{");

    await expectRefused(/round\.json is not JSON/);
  });

  it("refuses a round whose id is not a plain name", async () => {
    await editJson("round.json", (json) => (json.unit = "sample.batch"));
    await rebind();

    await expectRefused(/round id "sample\.batch-r2" is not a plain name/);
    expect(await entries()).toEqual([]);
  });

  it("refuses a source with no round.json", async () => {
    await rm(path.join(source, "round.json"));

    await expect(runImport()).rejects.toMatchObject({ code: EXIT.NOINPUT, message: expect.stringMatching(/no round\.json/) });
  });
});
