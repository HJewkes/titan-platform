import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, invokeCommand } from "@titan-design/registry";
import type { RequestAuth } from "@titan-design/daemon";
import { REFUSALS, type ConsoleContext } from "./owner-guard.js";
import { appendNote } from "./video-notes.js";
import { EXPLAINER_NOT_FOUND, MAX_EDIT_BYTES, NOT_FROM_EXPLAINER, videoPropsCommands } from "./video-props.js";
import { videoCatalog, videoId } from "./videos.js";

const FAKE_EXPLAINER = fileURLToPath(new URL("../fixtures/explainer/fake-explainer.mjs", import.meta.url));
const SYNTHETIC_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(52, 0x2e)]);
const MP4_SHA = createHash("sha256").update(SYNTHETIC_MP4).digest("hex");
const SCRIPT_SHA = "5".repeat(64);
const AT = new Date("2031-03-05T12:00:00.000Z");
const context: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: null, ownerWrites: false };
const OWNER_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const ownerContext: ConsoleContext = { ...context, auth: OWNER_AUTH, ownerWrites: true };

let dir: string;
let root: string;
let log: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "console-video-props-")));
  root = path.join(dir, "root");
  log = path.join(dir, "argv.jsonl");
  await mkdir(path.join(root, "orbit"), { recursive: true });
  await writeFile(path.join(root, "orbit", "cut.mp4"), SYNTHETIC_MP4);
  vi.stubEnv("EXPLAINER_FAKE_LOG", log);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const cutId = () => videoId(root, path.join("orbit", "cut.mp4"));
/** `null` serves the commands with no binary, as a config that found none does. */
const commands = (bin: string | null = FAKE_EXPLAINER) => videoPropsCommands(videoCatalog({ roots: [root] }), bin ?? undefined, () => AT);
const calls = async (): Promise<{ argv: string[]; stdin: string; consoleEnv: string[]; dataHome?: string }[]> => (await readFile(log, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));

async function props(bin?: string | null) {
  const { envelope } = await invokeCommand(commands(bin)["videos.props"], { videoId: cutId() }, context);
  if (!envelope.ok) throw new Error(envelope.error);
  return commands(bin)["videos.props"].result.parse(envelope.data);
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
    vi.stubEnv("EXPLAINER_FAKE_PROPS", "unknown");

    const result = await props();

    expect(result).toEqual({ mp4Sha: MP4_SHA, props: null, gaps: [NOT_FROM_EXPLAINER] });
  });

  it("names the exit code and the first stderr line when props fails", async () => {
    vi.stubEnv("EXPLAINER_FAKE_PROPS", "fail");

    const result = await props();

    expect(result.gaps).toEqual(["explainer props exited 2: props: run run-synthetic-0001 has no words artifact"]);
  });

  it("passes the CLI its data-dir variables and none of the daemon's TITAN_CONSOLE_* settings", async () => {
    vi.stubEnv("TITAN_CONSOLE_TOKEN", "synthetic-not-a-secret");
    vi.stubEnv("XDG_DATA_HOME", "/synthetic/data");

    await props();

    const [call] = await calls();
    expect(call!.consoleEnv).toEqual([]);
    expect(call!.dataHome).toBe("/synthetic/data");
  });

  it("runs the CLI once when the same render is opened again, and again after a failed read", async () => {
    const served = commands();
    const open = () => invokeCommand(served["videos.props"], { videoId: cutId() }, context);

    await open();
    await open();
    const afterAnswer = (await calls()).length;
    vi.stubEnv("EXPLAINER_FAKE_PROPS", "fail");
    const failing = commands();
    await invokeCommand(failing["videos.props"], { videoId: cutId() }, context);
    await invokeCommand(failing["videos.props"], { videoId: cutId() }, context);

    expect(afterAnswer).toBe(1);
    expect((await calls()).length).toBe(3);
  });

  it("names a relative TITAN_CONSOLE_EXPLAINER_BIN in its own gap and runs nothing", async () => {
    const read = await props("bin/explainer");
    const check = await editCheck({ "b-list": { slots: { title: "Ready" } } }, "bin/explainer");

    const gap = 'TITAN_CONSOLE_EXPLAINER_BIN must be an absolute path, got "bin/explainer"';
    expect(read.gaps).toEqual([gap]);
    expect(check).toMatchObject({ ok: true, data: { verdict: null, gaps: [gap] } });
    await expect(readFile(log, "utf8")).rejects.toThrow(/ENOENT/);
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

async function save(beats: Record<string, unknown>, extra: Record<string, unknown> = {}, ctx: ConsoleContext = ownerContext) {
  const { envelope } = await invokeCommand(commands()["videos.edit"], { videoId: cutId(), runId: "run-synthetic-0001", scriptSha: SCRIPT_SHA, beats, ...extra }, ctx);
  return envelope;
}

describe("videos.edit", () => {
  it.each([
    ["on loopback, which carries no credential", context, REFUSALS.noCredential],
    ["with a bearer token", { ...ownerContext, auth: { credential: "bearer", issuedAt: null, peerLocal: false } } satisfies ConsoleContext, REFUSALS.bearer],
    ["while owner writes are off", { ...ownerContext, ownerWrites: false }, REFUSALS.disabled],
  ])("is refused %s, and explainer is never run", async (_label, ctx, reason) => {
    const envelope = await save({ "b-list": { slots: { title: "Ready" } } }, {}, ctx);

    expect(envelope).toEqual({ ok: false, error: `owner-write command refused: ${reason}`, code: EXIT.NOPERM });
    await expect(readFile(log, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("saves edits to two beats as one `edit apply --start` over the current render, citing the note", async () => {
    const note = await appendNote(path.join(root, "orbit", "cut.mp4"), cutId(), { kind: "comment", about: "content", atS: 2, text: "say polling loop" });
    const beats = { "b-compare": { slots: { leftTitle: "Polling loop" } }, "b-list": { slots: { title: "Ready to ship" } } };

    const envelope = await save(beats, { fromNote: note.id });

    const applies = (await calls()).filter((call) => call.argv[1] === "apply");
    expect(applies.map((call) => call.argv)).toEqual([["edit", "apply", "-", "--start", "--json"]]);
    expect(JSON.parse(applies[0]!.stdin)).toEqual({
      schema: "explainer.slot-edit/v1",
      base: { runId: "run-synthetic-0001", scriptSha: SCRIPT_SHA, mp4Sha: MP4_SHA },
      beats,
      createdAt: AT.toISOString(),
      fromNote: note.id,
    });
    expect(envelope).toEqual({ ok: true, data: { saved: { editId: "edit-00000000000000bb", scriptSha: "6".repeat(64), started: true }, problems: [], gaps: [] } });
  });

  it("refuses a note that is not on this video without running explainer", async () => {
    const envelope = await save({ "b-list": { slots: { title: "Ready" } } }, { fromNote: "0123456789abcdef" });

    expect(envelope).toMatchObject({ ok: false, code: EXIT.DATAERR });
    await expect(readFile(log, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("returns explainer's problems when it refuses the edit, and saves nothing", async () => {
    const envelope = await save({ "b-compare": { slots: { leftTitle: "A title that runs well past the forty-eight character cap" } } });

    expect(envelope).toEqual({ ok: true, data: { saved: null, problems: ["beats.b-compare.visual.slots.leftTitle: Too big: expected string to have <=48 characters"], gaps: [] } });
  });

  it("returns explainer's refusal line for a second save of a started edit", async () => {
    vi.stubEnv("EXPLAINER_FAKE_APPLY", "started");

    const envelope = await save({ "b-list": { slots: { title: "Ready" } } });

    expect(envelope).toMatchObject({ ok: true, data: { saved: null, problems: ["edit: edit edit-00000000000000aa already started run run-synthetic-0002; one save makes one run"] } });
  });
});

describe("videos.edits", () => {
  it("lists the edits drafted over the render's sha256, each with its run status", async () => {
    const { envelope } = await invokeCommand(commands()["videos.edits"], { videoId: cutId() }, context);

    expect((await calls())[0]!.argv).toEqual(["edit", "list", "--mp4-sha", MP4_SHA, "--json"]);
    expect(envelope).toMatchObject({ ok: true, data: { edits: [{ editId: "edit-00000000000000aa", fromNote: "0123456789abcdef", runStatus: "completed" }, { editId: "edit-00000000000000cc", runStatus: "starting" }], gaps: [] } });
  });

  it("answers a gap line when no explainer binary is configured", async () => {
    const { envelope } = await invokeCommand(commands(null)["videos.edits"], { videoId: cutId() }, context);

    expect(envelope).toEqual({ ok: true, data: { edits: [], gaps: [EXPLAINER_NOT_FOUND] } });
  });
});

describe("the props commands' classes", () => {
  it("serve the reads as reads and the save as the one owner-write", () => {
    const served = commands();

    const classes = (["videos.props", "videos.edit-check", "videos.edits", "videos.edit"] as const).map((name) => served[name].commandClass);

    expect(classes).toEqual(["read", "read", "read", "owner-write"]);
  });
});
