import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, invokeCommand } from "@titan-design/registry";
import type { ConsoleContext } from "./owner-guard.js";
import { EXPLAINER_NOT_FOUND, MAX_EDIT_BYTES, NOT_FROM_EXPLAINER, videoPropsCommands } from "./video-props.js";
import { videoCatalog, videoId } from "./videos.js";

const FAKE_EXPLAINER = fileURLToPath(new URL("../fixtures/explainer/fake-explainer.mjs", import.meta.url));
const SYNTHETIC_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(52, 0x2e)]);
const MP4_SHA = createHash("sha256").update(SYNTHETIC_MP4).digest("hex");
const SCRIPT_SHA = "5".repeat(64);
const AT = new Date("2031-03-05T12:00:00.000Z");
const context: ConsoleContext = { warnings: [], format: "json", surface: "http" };

let dir: string;
let root: string;
let log: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "console-video-props-")));
  root = path.join(dir, "root");
  log = path.join(dir, "argv.jsonl");
  await mkdir(path.join(root, "orbit"), { recursive: true });
  await writeFile(path.join(root, "orbit", "cut.mp4"), SYNTHETIC_MP4);
  vi.stubEnv("FAKE_EXPLAINER_LOG", log);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const cutId = () => videoId(root, path.join("orbit", "cut.mp4"));
/** `null` serves the commands with no binary, as a config that found none does. */
const commands = (bin: string | null = FAKE_EXPLAINER) => videoPropsCommands(videoCatalog({ roots: [root] }), bin ?? undefined, () => AT);
const calls = async (): Promise<{ argv: string[]; stdin: string }[]> => (await readFile(log, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));

async function props(bin?: string | null) {
  const { envelope } = await invokeCommand(commands(bin)["videos.props"], { videoId: cutId() }, context);
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data;
}

async function editCheck(beats: Record<string, unknown>, bin?: string | null) {
  const { envelope } = await invokeCommand(commands(bin)["videos.edit-check"], { videoId: cutId(), runId: "run-synthetic-0001", scriptSha: SCRIPT_SHA, beats }, context);
  return envelope;
}

describe("videos.props", () => {
  it("asks explainer for the props of the render's sha256 and returns each template beat", async () => {
    const result = await props();

    expect((await calls())[0]!.argv).toEqual(["props", "--mp4-sha", MP4_SHA, "--json"]);
    expect(result.mp4Sha).toBe(MP4_SHA);
    expect(result.props?.beats.map((beat) => [beat.id, beat.slots, beat.startS, beat.endS])).toEqual([["b-compare", "compare", 0, 6.4], ["b-list", "list", 6.4, 12.8]]);
    expect(result.props?.saveBack).toEqual({ enabled: false, reason: "renders ignore edits until TP-2992 S3" });
    expect(result.gaps).toEqual([]);
  });

  it("answers a gap line, not an error, when no explainer binary is configured", async () => {
    const result = await props(null);

    expect(result).toEqual({ mp4Sha: MP4_SHA, props: null, gaps: [EXPLAINER_NOT_FOUND] });
  });

  it("answers a gap line when the configured binary does not exist", async () => {
    const result = await props(path.join(dir, "no-such-explainer"));

    expect(result.props).toBeNull();
    expect(result.gaps).toEqual([expect.stringMatching(/^explainer could not be run/)]);
  });

  it("answers a gap line when explainer did not make the render", async () => {
    vi.stubEnv("FAKE_EXPLAINER_PROPS", "unknown");

    const result = await props();

    expect(result).toEqual({ mp4Sha: MP4_SHA, props: null, gaps: [NOT_FROM_EXPLAINER] });
  });

  it("names the exit code and the first stderr line when props fails", async () => {
    vi.stubEnv("FAKE_EXPLAINER_PROPS", "fail");

    const result = await props();

    expect(result.gaps).toEqual(["explainer props exited 2: props: run run-synthetic-0001 has no words artifact"]);
  });

  it("refuses an id the catalog does not hold without running explainer", async () => {
    const { envelope } = await invokeCommand(commands()["videos.props"], { videoId: "v_00000000000000000000" }, context);

    expect(envelope).toMatchObject({ ok: false, code: EXIT.NOINPUT });
    await expect(readFile(log, "utf8")).rejects.toThrow(/ENOENT/);
  });
});

describe("videos.edit-check", () => {
  it("pipes a slot-edit over the current render to `edit check -` and returns its problems and diff", async () => {
    const envelope = await editCheck({ "b-compare": { slots: { leftTitle: "A title that runs well past the forty-eight character cap" } } });

    const [call] = await calls();
    expect(call!.argv).toEqual(["edit", "check", "-"]);
    expect(JSON.parse(call!.stdin)).toEqual({
      schema: "explainer.slot-edit/v1",
      base: { runId: "run-synthetic-0001", scriptSha: SCRIPT_SHA, mp4Sha: MP4_SHA },
      beats: { "b-compare": { slots: { leftTitle: "A title that runs well past the forty-eight character cap" } } },
      createdAt: AT.toISOString(),
    });
    expect(envelope).toMatchObject({
      ok: true,
      data: {
        verdict: { ok: false, problems: ["beats.b-compare.visual.slots.leftTitle: Too big: expected string to have <=48 characters"], diff: [{ path: "visual.slots.leftTitle", before: "Polling" }] },
        gaps: [],
      },
    });
  });

  it("answers a gap line when no explainer binary is configured", async () => {
    const envelope = await editCheck({ "b-list": { slots: { title: "Ready" } } }, null);

    expect(envelope).toMatchObject({ ok: true, data: { verdict: null, gaps: [EXPLAINER_NOT_FOUND] } });
  });

  it("refuses a draft over the size cap before running explainer", async () => {
    const envelope = await editCheck({ "b-list": { slots: { title: "x".repeat(MAX_EDIT_BYTES) } } });

    expect(envelope).toMatchObject({ ok: false, code: EXIT.DATAERR });
    await expect(readFile(log, "utf8")).rejects.toThrow(/ENOENT/);
  });
});

describe("the props reads", () => {
  it("are both read commands, so neither can write on the owner's behalf", () => {
    const served = commands();

    expect([served["videos.props"].commandClass, served["videos.edit-check"].commandClass]).toEqual(["read", "read"]);
  });
});
