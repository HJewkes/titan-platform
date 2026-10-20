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
const jsonObjects = z.array(jsonObject);
const readJson = async (file: string) => jsonObject.parse(JSON.parse(await readFile(file, "utf8")));

async function expectRefused(message: RegExp, from = source): Promise<void> {
  await expect(runImport(from)).rejects.toMatchObject({ message: expect.stringMatching(message) });
}

async function editJson(rel: string, edit: (json: Record<string, unknown>) => void): Promise<void> {
  const json = await readJson(path.join(source, rel));
  edit(json);
  await writeFile(path.join(source, rel), JSON.stringify(json));
}

const indexedFile = z.looseObject({ file: z.string(), sha256: z.string() });
const frameRecords = z.array(
  z.looseObject({ key: z.string(), file: z.string(), sha256: z.string(), base: z.looseObject({ file: z.string() }).optional(), after: indexedFile.optional() }),
);
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

  it("copies a frame's after file and serves it through rounds.frame", async () => {
    const afterRel = "frames/after/card-light.png";
    const afterBytes = await readFile(path.join(source, "frames", "card-dark.png"));
    await mkdir(path.join(source, "frames", "after"));
    await writeFile(path.join(source, afterRel), afterBytes);
    await editFrames((_frames, light) => (light.after = { file: afterRel, sha256: sha256Of(afterBytes) }));

    await runImport();

    expect(await readFile(path.join(roundsDir, ID, afterRel))).toEqual(afterBytes);
    expect((await getFrame({ dir: roundsDir }, ID, "card-light", "after")).sha256).toBe(sha256Of(afterBytes));
  });

  it("imports a round with no frames index and no feedback", async () => {
    await rm(path.join(source, "frames"), { recursive: true });
    await rm(path.join(source, "feedback.json"));
    await editVariant("card-light", (variant) => (variant.baseImage = "frames/base/card-light.png"));

    expect(await runImport()).toEqual({ id: ID, created: true, frames: 0, feedback: "none" });
    expect((await listRounds({ dir: roundsDir })).rounds).toEqual([expect.objectContaining({ id: ID, valid: true, status: "open" })]);
  });
});

describe("importRound reads review-schema 0.3", () => {
  it("imports a CI packet round that only review-schema 0.3 reads", async () => {
    const packet = path.join(FIXTURE_ROUNDS.dir, "td920-packet-r1");

    expect(await runImport(packet)).toMatchObject({ created: true, frames: 0, feedback: "none" });
    expect((await listRounds({ dir: roundsDir })).rounds).toEqual([expect.objectContaining({ valid: true, unit: "widgets-pr42-a1a1a1a1a1a1" })]);
  });
});

describe("importRound reads review-schema 0.3 feedback (TP-3272)", () => {
  it("imports a feedback.json whose answer rounds.submit marked recommendationSeen, with option notes", async () => {
    await editJson("feedback.json", (json) => {
      json.answers = [{ questionId: "ship-cards", pick: "Ship", recommendationSeen: true, optionNotes: [{ option: "Don't ship", note: "Not this time." }] }];
    });

    expect(await runImport()).toMatchObject({ created: true, feedback: "copied" });
  });

  it("still refuses a feedback.json with a key the schema does not know", async () => {
    await editJson("feedback.json", (json) => (json.foo = 1));

    await expectRefused(/feedback\.json: .*"foo"/);
    expect(await entries()).toEqual([]);
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

  it("refuses a destination frame that differs from the index and overwrites nothing", async () => {
    await runImport();
    const tampered = Buffer.from("not the frame");
    await writeFile(path.join(roundsDir, ID, LISTED[1]), tampered);

    await expectRefused(/not the frame frames\.json names/);
    expect(await readFile(path.join(roundsDir, ID, LISTED[1]))).toEqual(tampered);
  });

  it("refuses a symlinked destination parent before writing any missing frame", async () => {
    await runImport();
    const dest = path.join(roundsDir, ID);
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await cp(path.join(dest, "frames", "base"), path.join(elsewhere, "base"), { recursive: true });
    await rm(path.join(dest, "frames", "base"), { recursive: true });
    await symlink(path.join(elsewhere, "base"), path.join(dest, "frames", "base"));
    await rm(path.join(dest, "frames", "frames.json"));
    await rm(path.join(dest, LISTED[0]));

    await expectRefused(/is a symlink or not a directory/);
    expect(await entries(path.join(dest, "frames"))).not.toContain("card-light.png");
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

  it("refuses a Ship question with no merge binding and writes nothing", async () => {
    await editJson("round.json", (json) => {
      json.questions = jsonObjects.parse(json.questions).map(({ merge: _merge, page: _page, ...question }) => question);
    });

    await expectRefused(/question ship-cards: option "Ship" offers a merge, so it needs a merge binding/);
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

// The fixture's one Ship question merges example/cards#2 at this head.
const SHIP = { repo: "example/cards", pr: 2, headSha: "0123456789abcdef0123456789abcdef01234567" };
const AFTER = "frames/after/card-light.png";

/** Turns the fixture into a CI visual packet: packet.json and prose.json beside round.json, named in frames.json. */
async function addPacket(packet: Record<string, unknown> = {}): Promise<{ packet: Buffer; prose: Buffer }> {
  const packetBytes = Buffer.from(JSON.stringify({ schema: "titan-review/ci-packet@1", ...SHIP, headTree: "f".repeat(40), images: [], ...packet }));
  const proseBytes = Buffer.from(JSON.stringify({ summary: "Card padding drops to twelve pixels." }));
  await writeFile(path.join(source, "packet.json"), packetBytes);
  await writeFile(path.join(source, "prose.json"), proseBytes);
  await editJson("frames/frames.json", (json) => {
    json.packet = { file: "packet.json", sha256: sha256Of(packetBytes) };
    json.prose = { file: "prose.json", sha256: sha256Of(proseBytes) };
  });
  return { packet: packetBytes, prose: proseBytes };
}

describe("importRound copies a CI packet's files", () => {
  it("copies packet.json and prose.json 0600 beside round.json", async () => {
    const { packet, prose } = await addPacket();

    await runImport();

    const dest = path.join(roundsDir, ID);
    expect(await readFile(path.join(dest, "packet.json"))).toEqual(packet);
    expect(await readFile(path.join(dest, "prose.json"))).toEqual(prose);
    expect((await stat(path.join(dest, "packet.json"))).mode & 0o777).toBe(0o600);
  });

  it("copies no packet.json when frames.json names none", async () => {
    await writeFile(path.join(source, "packet.json"), "{}");

    await runImport();

    expect(await entries(path.join(roundsDir, ID))).not.toContain("packet.json");
  });

  it("adds a packet.json a re-import finds missing", async () => {
    const { packet } = await addPacket();
    await runImport();
    await rm(path.join(roundsDir, ID, "packet.json"));

    await runImport();

    expect(await readFile(path.join(roundsDir, ID, "packet.json"))).toEqual(packet);
  });

  it("copies and sha-checks a record's after image", async () => {
    const after = await readFile(path.join(source, LISTED[0]));
    await mkdir(path.join(source, "frames", "after"));
    await writeFile(path.join(source, AFTER), after);
    await editFrames((_frames, light) => (light.after = { file: AFTER, sha256: sha256Of(after) }));

    expect((await runImport()).frames).toBe(5);
    expect(await readFile(path.join(roundsDir, ID, AFTER))).toEqual(after);
  });

  it("refuses an after image whose sha256 does not match", async () => {
    await mkdir(path.join(source, "frames", "after"));
    await writeFile(path.join(source, AFTER), await readFile(path.join(source, LISTED[0])));
    await editFrames((_frames, light) => (light.after = { file: AFTER, sha256: "0".repeat(64) }));

    await expectRefused(/does not match the frames index sha256/);
    expect(await entries()).toEqual([]);
  });

  const bindings: [string, Record<string, unknown>][] = [
    ["another head", { headSha: "1".repeat(40) }],
    ["another PR", { pr: 3 }],
    ["another repo", { repo: "example/other" }],
  ];

  it.each(bindings)("refuses a packet.json that binds %s than the Ship question", async (_name, packet) => {
    await addPacket(packet);

    await expectRefused(/packet\.json binds .* a Ship question example\/cards#2 at 0123456789abcdef/);
    expect(await entries()).toEqual([]);
  });

  const refusals: [string, () => Promise<void>, RegExp][] = [
    ["a packet.json sha256 mismatch", () => editJson("frames/frames.json", (json) => (json.packet = { file: "packet.json", sha256: "0".repeat(64) })), /packet\.json does not match/],
    ["a prose.json sha256 mismatch", () => writeFile(path.join(source, "prose.json"), "{}"), /prose\.json does not match/],
    ["a packet named away from round.json", () => editJson("frames/frames.json", (json) => (json.packet = { ...indexedFile.parse(json.packet), file: "frames/packet.json" })), /must name packet\.json beside round\.json/],
    ["a named packet.json that is missing", () => rm(path.join(source, "packet.json")), /names packet\.json but the source has none/],
    ["a symlinked packet.json", () => symlinkInPlace("packet.json"), /packet\.json is a symlink/],
    ["a round with no merge-bound question", () => dropShipBinding(), /has no merge-bound Ship question/],
  ];

  it.each(refusals)("refuses %s and writes nothing", async (_name, arrange, message) => {
    await addPacket();
    await arrange();

    await expectRefused(message);
    expect(await entries()).toEqual([]);
  });

  it("refuses a packet.json that is not JSON or not a ci-packet@1 packet", async () => {
    await addPacket();
    await rebindPacket(Buffer.from("{"));
    await expectRefused(/packet\.json is not JSON/);

    await rebindPacket(Buffer.from(JSON.stringify({ ...SHIP, schema: "titan-review/ci-packet@2" })));
    await expectRefused(/packet\.json is not a ci-packet@1 packet/);
    expect(await entries()).toEqual([]);
  });
});

describe("importRound takes a Ship round only as one main-vs-head package (TP-3520)", () => {
  async function addVariant(variant: Record<string, unknown>): Promise<void> {
    await editJson("round.json", (json) => {
      json.variants = [...jsonObjects.parse(json.variants), variant];
      const [section] = jsonObjects.parse(json.sections);
      json.sections = [{ ...section, variantKeys: [...z.array(z.string()).parse(section?.variantKeys), variant.key] }];
    });
    await rebind();
  }

  async function expectShipRefused(message: RegExp): Promise<void> {
    await expectRefused(message);
    expect(await entries()).toEqual([]);
  }

  it("imports a clean Ship round: one merge, every frame paired with main or marked new at head", async () => {
    expect(await runImport()).toMatchObject({ id: ID, created: true });
  });

  it("refuses a Ship round with a second merge-bound question, naming both", async () => {
    await editJson("round.json", (json) => {
      const [ship] = jsonObjects.parse(json.questions);
      const merge = jsonObject.parse(ship?.merge);
      const second = { ...ship, id: "ship-cards-3", prompt: "Ship example/cards#3 at 0123456789ab?", page: "example/cards#3", merge: { ...merge, pr: 3 } };
      json.questions = [ship, second];
    });
    await editJson("round.json", (json) => {
      const [section] = jsonObjects.parse(json.sections);
      json.sections = [{ ...section, questionIds: ["ship-cards", "ship-cards-3"] }];
    });
    await rebind();

    await expectShipRefused(/a Ship round binds one merge, not 2 \(ship-cards, ship-cards-3\)/);
  });

  it("refuses a frame with no main frame that is not marked new at head, naming the frame", async () => {
    await editVariant("card-dark", (variant) => delete variant.change);
    await rebind();

    await expectShipRefused(/frame card-dark has no main frame/);
  });

  it("takes \"(new at head)\" in a label as the new-at-head mark", async () => {
    await editVariant("card-dark", (variant) => {
      delete variant.change;
      variant.label = "Card, dark (new at head)";
    });
    await rebind();

    expect(await runImport()).toMatchObject({ created: true });
  });

  it("imports a lab-only PR's Ship round: its one frame is a lab- story, new at head (TD-993 regression)", async () => {
    await rm(path.join(source, "frames"), { recursive: true });
    await rm(path.join(source, "feedback.json"));
    await editJson("round.json", (json) => {
      json.variants = [{ key: "fd-5-family-l", storyId: "lab-decisions-foundations--fd-5-family-l", label: "Foundations, family L", change: "new" }];
      json.sections = jsonObjects.parse(json.sections).map((section) => ({ ...section, variantKeys: ["fd-5-family-l"] }));
    });

    expect(await runImport()).toMatchObject({ id: ID, created: true });
  });

  it("imports a paired frame whose label names a lab", async () => {
    await editVariant("card-light", (variant) => (variant.label = "Lab card, light"));
    await rebind();

    expect(await runImport()).toMatchObject({ created: true });
  });

  it.each([
    ["an A/B label", { key: "card-ab", label: "Card, A/B pick" }, /variant card-ab is exploration \("A\/B"/],
    ["a proposal key", { key: "card-proposal-2", label: "Card" }, /variant card-proposal-2 is exploration \("proposal"/],
    ["an alpha label", { key: "card-faded", label: "Card, alpha 40" }, /variant card-faded is exploration \("alpha"/],
    ["an alternate column", { key: "card-col", label: "Card", alternate: "b" }, /variant card-col is exploration \(alternate "b"/],
  ])("refuses %s", async (_name, marked, message) => {
    await addVariant({ image: "frames/card-dark.png", change: "new", ...marked });

    await expectShipRefused(message);
  });

  it("still imports exploration in a round with no merge-bound question", async () => {
    await dropShipBinding();
    await addVariant({ key: "card-chosen", storyId: "lab-decisions-card--chosen", label: "Card, chosen" });

    expect(await runImport()).toMatchObject({ created: true });
  });
});

async function editVariant(key: string, edit: (variant: Record<string, unknown>) => void): Promise<void> {
  await editJson("round.json", (json) => {
    const variants = jsonObjects.parse(json.variants);
    const variant = variants.find((each) => each.key === key);
    if (variant === undefined) throw new Error(`the fixture has no variant ${key}`);
    edit(variant);
    json.variants = variants;
  });
}

async function symlinkInPlace(rel: string): Promise<void> {
  const real = path.join(root, `real-${path.basename(rel)}`);
  await cp(path.join(source, rel), real);
  await rm(path.join(source, rel));
  await symlink(real, path.join(source, rel));
}

async function rebindPacket(bytes: Buffer): Promise<void> {
  await writeFile(path.join(source, "packet.json"), bytes);
  await editJson("frames/frames.json", (json) => (json.packet = { file: "packet.json", sha256: sha256Of(bytes) }));
}

/**
 * Turns the Ship question into one that offers no merge: drops its binding, its page (the schema requires a Ship
 * question per page) and its Ship wording (an unbound "Ship" is itself refused), then rebinds frames.json and
 * feedback.json to the new round.json.
 */
async function dropShipBinding(): Promise<void> {
  await editJson("round.json", (json) => {
    json.questions = jsonObjects.parse(json.questions).map(({ merge: _merge, page: _page, ...question }) => ({
      ...question,
      options: ["Keep", "Rework"],
      recommendation: { ...jsonObject.parse(question.recommendation), answer: "Keep" },
    }));
  });
  await rebind();
}
