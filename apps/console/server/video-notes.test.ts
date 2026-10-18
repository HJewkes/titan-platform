import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, type DaemonHandle, type RequestAuth } from "@titan-design/daemon";
import { EXIT, invokeCommand } from "@titan-design/registry";
import type { ConsoleConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import { REFUSALS, type ClassedCommand, type ConsoleContext } from "./owner-guard.js";
import { closedPort } from "./test-support.js";
import { MAX_NOTE_TEXT, VIDEO_NOTE_SCHEMA, appendNote, currentVerdict, notesFileOf, openNotes, readNotes, renderSha256, summarizeNotes, videoNotesCommands, type VideoNote } from "./video-notes.js";
import { videoCatalog, videoId, videosCommands } from "./videos.js";

/** An `ftyp` box and padding: enough to look like an mp4, never a real render. */
const SYNTHETIC_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(52, 0x2e)]);
const RE_RENDERED_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(52, 0x2f)]);
const OWNER_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

let dir: string;
let root: string;
let video: string;
let handle: DaemonHandle | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "console-video-notes-")));
  root = path.join(dir, "root");
  video = path.join(root, "orbit", "cut.mp4");
  await mkdir(path.dirname(video), { recursive: true });
  await writeFile(video, SYNTHETIC_MP4);
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await rm(dir, { recursive: true, force: true });
});

const ownerContext = (): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth: OWNER_AUTH, ownerWrites: true });
const comment = (text: string, atS = 1) => ({ kind: "comment" as const, atS, text });

let sequence = 0;
function note(renderSha256: string, body: { kind: "comment"; text: string } | { kind: "verdict"; verdict: "ship" | "needs-changes" }): VideoNote {
  sequence += 1;
  const head = { schema: VIDEO_NOTE_SCHEMA, id: sequence.toString(16).padStart(16, "0"), videoId: "v_0", video: "cut.mp4", renderSha256, atS: sequence, createdAt: new Date(sequence * 1000).toISOString() };
  return { ...head, ...body } as VideoNote;
}

describe("the notes sidecar", () => {
  it("keeps both of two appends, in order, as one parsable line each", async () => {
    await appendNote(video, "v_0", comment("tighten the outro", 12.3456));
    await appendNote(video, "v_0", comment("hold the title card longer", 3));

    const lines = (await readFile(notesFileOf(video), "utf8")).trimEnd().split("\n");

    expect(notesFileOf(video)).toBe(path.join(root, "orbit", "cut.notes.jsonl"));
    expect(lines.map((line) => (JSON.parse(line) as VideoNote).kind === "comment" && (JSON.parse(line) as { text: string }).text)).toEqual(["tighten the outro", "hold the title card longer"]);
    expect((JSON.parse(lines[0]!) as VideoNote).atS).toBe(12.346);
    expect((await stat(notesFileOf(video))).mode & 0o777).toBe(0o600);
  });

  it("marks notes made before a re-render as not current, and leaves them out of the open notes", async () => {
    await appendNote(video, "v_0", comment("tighten the outro"));
    await writeFile(video, RE_RENDERED_MP4);
    await utimes(video, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    await appendNote(video, "v_0", comment("the new outro lands"));

    const { notes } = await readNotes(video);

    expect(notes.map(({ current }) => current)).toEqual([false, true]);
    expect(openNotes(notes, await renderSha256(video)).map((each) => each.kind === "comment" && each.text)).toEqual(["the new outro lands"]);
  });

  it("skips a garbage line into the gap count and reads the rest", async () => {
    await appendNote(video, "v_0", comment("tighten the outro"));
    await writeFile(notesFileOf(video), "{not json\n", { flag: "a" });
    await appendNote(video, "v_0", { kind: "verdict", atS: 4, verdict: "needs-changes" });

    const { notes, skipped, gaps, verdict } = await readNotes(video);

    expect(notes).toHaveLength(2);
    expect({ skipped, gaps, verdict }).toEqual({ skipped: 1, gaps: ["1 unreadable note line skipped"], verdict: "needs-changes" });
  });

  it("refuses to append through a symlink planted at the sidecar's name", async () => {
    const elsewhere = path.join(dir, "elsewhere.jsonl");
    await writeFile(elsewhere, "");
    await symlink(elsewhere, notesFileOf(video));

    await expect(appendNote(video, "v_0", comment("tighten the outro"))).rejects.toThrow("the notes file could not be opened");
    expect(await readFile(elsewhere, "utf8")).toBe("");
  });
});

describe("the agent pickup rule", () => {
  it("opens current-render comments after the latest current-render Ship, whatever an earlier render's verdicts say", () => {
    const notes = [
      note(SHA_B, { kind: "comment", text: "closed by the ship" }),
      note(SHA_B, { kind: "verdict", verdict: "ship" }),
      note(SHA_B, { kind: "comment", text: "after the ship" }),
      note(SHA_A, { kind: "verdict", verdict: "ship" }),
      note(SHA_A, { kind: "comment", text: "on the earlier render" }),
      note(SHA_B, { kind: "comment", text: "later still" }),
    ];

    expect(openNotes(notes, SHA_B).map((each) => each.kind === "comment" && each.text)).toEqual(["after the ship", "later still"]);
  });

  it("takes the verdict from the current render, not the last verdict in the file", () => {
    const notes = [note(SHA_B, { kind: "verdict", verdict: "needs-changes" }), note(SHA_A, { kind: "verdict", verdict: "ship" })];

    expect(currentVerdict(notes, SHA_B)).toBe("needs-changes");
    expect(currentVerdict(notes, "c".repeat(64))).toBeNull();
  });
});

describe("videos.note and videos.notes", () => {
  const commandsFor = () => videoNotesCommands(videoCatalog({ roots: [root] }));
  const cutId = () => videoId(root, path.join("orbit", "cut.mp4"));

  it("stores an owner comment and reads it back as current, with videos.list counting it", async () => {
    const commands = commandsFor();

    const stored = await invokeCommand(commands["videos.note"], { videoId: cutId(), ...comment("tighten the outro", 7) }, ownerContext());
    const read = await invokeCommand(commands["videos.notes"], { videoId: cutId() }, ownerContext());
    const listed = await invokeCommand(videosCommands(videoCatalog({ roots: [root] }), summarizeNotes)["videos.list"], {}, ownerContext());

    expect(stored.envelope).toMatchObject({ ok: true, data: { schema: VIDEO_NOTE_SCHEMA, videoId: cutId(), video: "cut.mp4", atS: 7, kind: "comment" } });
    expect(read.envelope).toMatchObject({ ok: true, data: { video: "cut.mp4", verdict: null, gaps: [], notes: [{ text: "tighten the outro", current: true }] } });
    expect(listed.envelope).toMatchObject({ ok: true, data: { videos: [{ id: cutId(), noteCount: 1, verdict: null }] } });
  });

  it(`refuses text over ${MAX_NOTE_TEXT} characters and writes nothing`, async () => {
    const { envelope } = await invokeCommand(commandsFor()["videos.note"], { videoId: cutId(), ...comment("x".repeat(MAX_NOTE_TEXT + 1)) }, ownerContext());

    expect(envelope).toMatchObject({ ok: false, code: EXIT.DATAERR });
    await expect(stat(notesFileOf(video))).rejects.toThrow();
  });

  it("refuses a verdict that carries text, and an unknown video with fixed text", async () => {
    const commands = commandsFor();

    const mixed = await invokeCommand(commands["videos.note"], { videoId: cutId(), kind: "verdict", atS: 0, verdict: "ship", text: "and a comment" }, ownerContext());
    const unknown = await invokeCommand(commands["videos.notes"], { videoId: `v_${"0".repeat(20)}` }, ownerContext());

    expect(mixed.envelope).toEqual({ ok: false, error: "a verdict carries a verdict and no text", code: EXIT.DATAERR });
    expect(unknown.envelope).toEqual({ ok: false, error: "Video not found", code: EXIT.NOINPUT });
  });

  it("is an owner-write: refused over loopback with no credential, and nothing is written", async () => {
    const config: ConsoleConfig = {
      port: 0,
      stateDir: path.join(dir, "state"),
      activeWorkPort: await closedPort(),
      agentChatPort: await closedPort(),
      factoryPort: await closedPort(),
      agentChatTokenPath: path.join(dir, "ui.token"),
      agentChatEventsDbPath: path.join(dir, "events.db"),
      seatPrefixes: [],
      sessionGraphPath: path.join(dir, "graph.sqlite3"),
      codewatchUrl: "http://codewatch.test:7433",
      lanHost: null,
      lanNames: [],
      lanTls: null,
      lanTokenPath: path.join(dir, "state", "lan.token"),
      ownerWrites: true,
      gateAnswers: false,
      inboxDir: path.join(dir, "state", "inbox"),
      roundsDir: path.join(dir, "state", "rounds"),
      decisionsFile: null,
      videoRoots: [root],
    };
    handle = await startConsoleDaemon({ config, logger: silentLogger });

    const res = await fetch(`http://127.0.0.1:${handle.port}/rpc/videos.note`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-titan-client": "test" },
      body: JSON.stringify({ videoId: cutId(), ...comment("tighten the outro") }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(`owner-write command refused: ${REFUSALS.noCredential}`);
    expect((commandsFor()["videos.note"] as ClassedCommand).commandClass).toBe("owner-write");
    await expect(stat(notesFileOf(video))).rejects.toThrow();
  });
});
