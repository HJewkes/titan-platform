import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importRound } from "./round-import.js";
import { storybookLiveReader } from "./round-live.js";
import { getRound, parseManifest, type RoundDetail } from "./rounds.js";
import { buildIdOf, pinReason, type BuildFile, type LiveFrame } from "./storybook-build.js";

// Synthetic: the lantern-cards fixture round with a three-file static build beside it.
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "rounds", "lantern-cards-r1");
const ID = "lantern-cards-r1";
const BUILD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("synthetic")]);

const BUILD_FILES: Record<string, string> = {
  "iframe.html": '<!doctype html><html><head></head><body><div id="storybook-root"></div></body></html>',
  "index.json": JSON.stringify({
    v: 5,
    entries: {
      "lantern-card--compact": { id: "lantern-card--compact", type: "story" },
      "lantern-card--roomy": { id: "lantern-card--roomy", type: "story" },
      "lantern-card--docs": { id: "lantern-card--docs", type: "docs" },
    },
  }),
  "assets/a-hash.js": "export const a = 1;\n",
};

let root: string;
let source: string;
let roundsDir: string;
let storybooksDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-storybook-store-"));
  source = path.join(root, "harness", "round-1");
  roundsDir = path.join(root, "state", "rounds");
  storybooksDir = path.join(root, "state", "storybooks");
  await cp(FIXTURE, source, { recursive: true });
  await anchorQuestion();
  await writeBuild();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha256Of = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const staticDir = (from = source) => path.join(from, "storybook", "static");
const listing = (files: Record<string, string>): BuildFile[] =>
  Object.entries(files).map(([rel, text]) => ({ path: rel, sha256: sha256Of(text), bytes: Buffer.byteLength(text) }));

interface BuildOptions {
  from?: string;
  builtAt?: string;
  sha?: string;
  dirty?: boolean;
  edit?: (files: BuildFile[]) => BuildFile[];
}

/** Writes the build's files and a storybook@1 sidecar that lists them, after `edit`. */
async function writeBuild({ from = source, builtAt = "2026-10-21T00:00:00Z", sha = BUILD_SHA, dirty = false, edit = (files) => files }: BuildOptions = {}): Promise<void> {
  for (const [rel, text] of Object.entries(BUILD_FILES)) {
    await mkdir(path.dirname(path.join(staticDir(from), rel)), { recursive: true });
    await writeFile(path.join(staticDir(from), rel), text);
  }
  const files = edit(listing(BUILD_FILES));
  const sidecar = { schema: "titan-review/storybook@1", repo: "example-org/example-ui", sha, dirty, builtAt, storybookVersion: "10.0.0", storyIds: 2, files };
  await writeFile(path.join(from, "storybook", "storybook.json"), JSON.stringify(sidecar));
}

async function editRound(edit: (round: Record<string, unknown>) => void, from = source): Promise<void> {
  const round = JSON.parse(await readFile(path.join(from, "round.json"), "utf8")) as Record<string, unknown>;
  edit(round);
  await writeFile(path.join(from, "round.json"), JSON.stringify(round));
}

/** The fixture's pick names no frames, which the import's builder rules refuse. */
const anchorQuestion = (from = source) =>
  editRound((round) => {
    for (const question of round.questions as Record<string, unknown>[]) question.frames = ["compact", "roomy"];
  }, from);

/** A frames.json whose roomy record is shot in the light theme, bound to the source's round.json. */
async function writeFramesIndex(): Promise<void> {
  await mkdir(path.join(source, "frames"), { recursive: true });
  await writeFile(path.join(source, "frames", "roomy.png"), PNG);
  const manifestSha256 = sha256Of(await readFile(path.join(source, "round.json")));
  const index = { schema: "titan-review/frames@1", unit: "lantern-cards", round: 1, manifestSha256, frames: [{ key: "roomy", theme: "light", file: "frames/roomy.png", sha256: sha256Of(PNG) }] };
  await writeFile(path.join(source, "frames", "frames.json"), JSON.stringify(index));
}

const runImport = (from = source) => importRound({ source: from, roundsDir, storybooksDir });
const stored = () => readdir(storybooksDir).catch(() => []);
const expectRefused = (message: RegExp, from = source) => expect(runImport(from)).rejects.toMatchObject({ message: expect.stringMatching(message) });

async function liveOf(id = ID): Promise<Record<string, LiveFrame>> {
  const detail: RoundDetail = await getRound({ dir: roundsDir, live: storybookLiveReader(storybooksDir) }, id);
  if (!detail.valid || detail.live === undefined) throw new Error("the round has no live field");
  return detail.live.frames;
}

const urlOf = (frame: LiveFrame | undefined): URL => {
  if (frame === undefined || !("url" in frame)) throw new Error(`no live url: ${JSON.stringify(frame)}`);
  return new URL(frame.url, "https://story.example");
};
const reasonOf = (frame: LiveFrame | undefined): string | undefined => (frame && "reason" in frame ? frame.reason : undefined);

describe("importing a round's Storybook build", () => {
  it("files the build once under its content id, and a second round shipping the same bytes adds no copy", async () => {
    const second = path.join(root, "harness", "round-2");
    await cp(FIXTURE, second, { recursive: true });
    await anchorQuestion(second);
    await editRound((round) => (round.round = 2), second);
    await writeBuild({ from: second, builtAt: "2026-10-22T09:30:00Z" });

    await runImport();
    await runImport(second);

    const buildId = buildIdOf(listing(BUILD_FILES));
    expect(await stored()).toEqual([buildId]);
    expect(await readFile(path.join(storybooksDir, buildId, "assets", "a-hash.js"), "utf8")).toBe(BUILD_FILES["assets/a-hash.js"]);
    expect(await readdir(path.join(roundsDir, ID, "storybook"))).toEqual(["storybook.json"]);
  });

  it("refuses the whole import when any file's bytes differ from its sha256, leaving the store and rounds empty", async () => {
    await writeFile(path.join(staticDir(), "assets", "a-hash.js"), "export const a = 2;\n");

    await expectRefused(/assets\/a-hash\.js does not match the storybook\.json sha256/);

    expect(await stored()).toEqual([]);
    expect(await readdir(roundsDir).catch(() => [])).toEqual([]);
  });

  it("refuses a build file that is a symlink, even to identical bytes", async () => {
    const outside = path.join(root, "outside.js");
    await writeFile(outside, BUILD_FILES["assets/a-hash.js"] ?? "");
    await rm(path.join(staticDir(), "assets", "a-hash.js"));
    await symlink(outside, path.join(staticDir(), "assets", "a-hash.js"));

    await expectRefused(/assets\/a-hash\.js is a symlink/);
    expect(await stored()).toEqual([]);
  });

  it("refuses a listed path that climbs out of the build or names a dotfile", async () => {
    for (const bad of ["../round.json", "assets/../../round.json", ".env"]) {
      await writeBuild({ edit: (files) => [...files, { path: bad, sha256: sha256Of(""), bytes: 0 }] });
      await expectRefused(/is not a plain relative path/);
    }
    expect(await stored()).toEqual([]);
  });

  it("refuses a build over 5,000 files or over 100 MB before reading any of it", async () => {
    await writeBuild({ edit: (files) => [...files, ...Array.from({ length: 5000 }, (_, at) => ({ path: `assets/f${at}.js`, sha256: sha256Of(""), bytes: 0 }))] });
    await expectRefused(/over 5000 files/);

    await writeBuild({ edit: (files) => [...files, { path: "assets/huge.js", sha256: sha256Of(""), bytes: 100 * 1024 * 1024 }] });
    await expectRefused(/over 104857600 bytes/);
    expect(await stored()).toEqual([]);
  });

  it("refuses a re-import whose storybook.json differs from the one already filed", async () => {
    await runImport();
    await writeBuild({ builtAt: "2026-10-23T00:00:00Z" });

    await expectRefused(/already imported with a different storybook\.json/);
  });

  it("refuses a round with a build when the console has no store for it", async () => {
    await expect(importRound({ source, roundsDir })).rejects.toMatchObject({ message: expect.stringMatching(/no store/) });
  });
});

describe("rounds.get live", () => {
  it("gives each story variant a url on the build, relative to the story origin", async () => {
    await runImport();

    const frames = await liveOf();

    const compact = urlOf(frames.compact);
    expect(compact.pathname).toBe(`/sb/${buildIdOf(listing(BUILD_FILES))}/iframe.html`);
    expect(Object.fromEntries(compact.searchParams)).toEqual({ id: "lantern-card--compact", viewMode: "story", shortcuts: "false", singleStory: "true" });
    expect(frames.compact).toMatchObject({ buildSha: BUILD_SHA });
  });

  it("marks a frame from a build of uncommitted changes as dirty", async () => {
    await writeBuild({ dirty: true });
    await runImport();

    expect((await liveOf()).compact).toMatchObject({ buildSha: BUILD_SHA, dirty: true });
  });

  it("names both shas when the build is not the PR group's head, even when it is the recorded main sha", async () => {
    await editRound((round) => {
      round.prGroups = [{ pr: "example-org/example-ui#7", headSha: OTHER_SHA, sectionIds: ["density"] }];
      round.build = { mainSha: BUILD_SHA, mergeSha: "c".repeat(40) };
    });
    await runImport();

    expect(reasonOf((await liveOf()).compact)).toBe("Live build is for aaaaaaa; this round is at bbbbbbb");
  });

  it("accepts a build of the round's recorded merge sha", async () => {
    await editRound((round) => {
      round.prGroups = [{ pr: "example-org/example-ui#7", headSha: OTHER_SHA, sectionIds: ["density"] }];
      round.build = { mainSha: "c".repeat(40), mergeSha: BUILD_SHA };
    });
    await runImport();

    expect(urlOf((await liveOf()).compact).searchParams.get("id")).toBe("lantern-card--compact");
  });

  it("gives a story id the build's index.json does not list a reason and no url", async () => {
    await editRound((round) => {
      const [compact] = round.variants as Record<string, unknown>[];
      if (compact) compact.storyId = "lantern-card--missing";
    });
    await runImport();

    expect(reasonOf((await liveOf()).compact)).toMatch(/^unknown story lantern-card--missing/);
  });

  it("gives args Storybook would strip from the url a reason and no url", async () => {
    await editRound((round) => {
      const [compact] = round.variants as Record<string, unknown>[];
      if (compact) compact.args = { label: "a;b" };
    });
    await runImport();

    expect(reasonOf((await liveOf()).compact)).toMatch(/^unsafe args: args\.label = "a;b"/);
  });

  it("sets globals.theme from the frames.json record, so the live frame matches its PNG", async () => {
    await writeFramesIndex();
    await runImport();

    const frames = await liveOf();

    expect(urlOf(frames.roomy).searchParams.get("globals")).toBe("theme:light");
    expect(urlOf(frames.compact).searchParams.has("globals")).toBe(false);
  });

  it("refuses a stored index.json that leads outside its build, even to identical bytes", async () => {
    await runImport();
    const buildDir = path.join(storybooksDir, buildIdOf(listing(BUILD_FILES)));
    const outside = path.join(root, "index.json");
    await writeFile(outside, BUILD_FILES["index.json"] ?? "");
    await rm(path.join(buildDir, "index.json"));
    await symlink(outside, path.join(buildDir, "index.json"));

    expect(reasonOf((await liveOf()).compact)).toBe("the stored build's index.json leads outside the build");
  });

  it("shows the PNG with a reason when the build is no longer in the store", async () => {
    await runImport();
    await rm(storybooksDir, { recursive: true });

    expect(reasonOf((await liveOf()).roomy)).toBe("the build is not in the console's store");
  });

  it("has no live field for a round that carries no build", async () => {
    await rm(path.join(source, "storybook"), { recursive: true });
    await runImport();

    const detail = await getRound({ dir: roundsDir, live: storybookLiveReader(storybooksDir) }, ID);

    expect(detail).not.toHaveProperty("live");
  });
});

describe("pinReason", () => {
  const SHIP_HEAD = "0123456789abcdef0123456789abcdef01234567";

  it("pins a round with no PR group to its merge-bound Ship head", async () => {
    const parsed = parseManifest(await readFile(path.join(import.meta.dirname, "..", "fixtures", "import", "sample-batch-r2", "round.json")));
    if (!parsed.ok) throw new Error(parsed.reason);

    expect(pinReason(parsed.manifest, "card-light", SHIP_HEAD)).toBeUndefined();
    expect(pinReason(parsed.manifest, "card-light", BUILD_SHA)).toBe("Live build is for aaaaaaa; this round is at 0123456");
  });
});
