import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EXIT, invokeCommand } from "@titan-design/registry";
import type { RequestAuth } from "@titan-design/daemon";
import { roundsSweepArgs } from "./cli-rounds-sweep.js";
import type { ConsoleContext } from "./owner-guard.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { importRound } from "./round-import.js";
import { sweepRounds } from "./round-sweep.js";
import { parseManifest, statusOf } from "./rounds.js";
import { roundsSubmitCommands } from "./rounds-submit.js";

// Synthetic only: every round is a copy of the kiln-schedule fixtures, and the decisions file is written here.
const SENT = "kiln-schedule-r1";
const OPEN_A = "kiln-a-r1";
const OPEN_B = "kiln-b-r1";
const NEWER = "kiln-schedule-r3";
const AT = new Date("2026-10-22T12:00:00.000Z");
const SPAWN_TIMEOUT_MS = 30_000;
const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const KILN_ANSWERS = [
  { questionId: "ramp-default", pick: "Single slope" },
  { questionId: "hold-clarity", value: 4 },
  { questionId: "report-columns", picks: ["Segment"] },
  { questionId: "report-notes", text: "Print the cone number." },
];

let root: string;
let dir: string;
let openJson: Record<string, unknown>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-round-sweep-"));
  dir = path.join(root, "rounds");
  await mkdir(dir);
  await cp(path.join(FIXTURE_ROUNDS.dir, SENT), path.join(dir, SENT), { recursive: true });
  openJson = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path.join(FIXTURE_ROUNDS.dir, "kiln-schedule-r2", "round.json"), "utf8")));
  for (const id of [OPEN_A, OPEN_B]) await writeRound(path.join(dir, id), openJson);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRound(roundDir: string, json: unknown): Promise<string> {
  await mkdir(roundDir, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(json));
  await writeFile(path.join(roundDir, "round.json"), bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

const newer = (supersedes: string[]) => ({ ...openJson, round: 3, supersedes });
const withdrawnOf = (id: string) => path.join(dir, id, "withdrawn.json");
const exists = (file: string) => stat(file).then(() => true, () => false);
const reasonOf = async (id: string) => z.object({ reason: z.string() }).parse(JSON.parse(await readFile(withdrawnOf(id), "utf8"))).reason;
const statuses = async () => Object.fromEntries(await Promise.all((await readdir(dir)).map(async (id) => [id, await statusOf(path.join(dir, id))])));

async function writeDecisions(lines: string[]): Promise<string> {
  const file = path.join(root, "decisions.md");
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

const sweep = (options: { apply: boolean; decisionsFile?: string | null }) => sweepRounds({ roundsDir: dir, decisionsFile: null, now: AT, ...options });

describe("supersedes in round.json", () => {
  it("is read as plain round ids, and a round without it reads as before", () => {
    const parsed = parseManifest(Buffer.from(JSON.stringify(newer([OPEN_A]))));
    const plain = parseManifest(Buffer.from(JSON.stringify(openJson)));

    expect(parsed.ok && parsed.manifest.supersedes).toEqual([OPEN_A]);
    expect(plain.ok && "supersedes" in plain.manifest).toBe(false);
  });

  it.each([[["../kiln-a-r1"]], [[]], [["kiln a"]]])("refuses supersedes %j", (supersedes) => {
    const parsed = parseManifest(Buffer.from(JSON.stringify(newer(supersedes))));

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toMatch(/^supersedes/);
  });

  it("still refuses a key review-schema does not know", () => {
    const parsed = parseManifest(Buffer.from(JSON.stringify({ ...openJson, replaces: [OPEN_A] })));

    expect(parsed.ok).toBe(false);
  });
});

describe("importing a round that supersedes others", () => {
  it("withdraws only the open rounds it names, keeps an answered one and reports an unknown id", async () => {
    const source = path.join(root, "source");
    await writeRound(source, newer([OPEN_A, SENT, "no-such-r9"]));

    const result = await importRound({ source, roundsDir: dir });

    expect(result).toMatchObject({ id: NEWER, created: true });
    expect(result.superseded).toEqual([
      { id: OPEN_A, outcome: "withdrawn" },
      { id: SENT, outcome: "kept-answered" },
      { id: "no-such-r9", outcome: "unknown" },
    ]);
    expect(await reasonOf(OPEN_A)).toBe(`superseded-by:${NEWER}`);
    expect(await exists(withdrawnOf(SENT))).toBe(false);
    expect(await statuses()).toEqual({ [OPEN_A]: "withdrawn", [OPEN_B]: "open", [SENT]: "sent", [NEWER]: "open" });
  });

  it("changes nothing when the same round is imported again", async () => {
    const source = path.join(root, "source");
    await writeRound(source, newer([OPEN_A]));
    await importRound({ source, roundsDir: dir });
    const first = await readFile(withdrawnOf(OPEN_A), "utf8");

    const again = await importRound({ source, roundsDir: dir });

    expect(again.superseded).toEqual([{ id: OPEN_A, outcome: "already-withdrawn" }]);
    expect(await readFile(withdrawnOf(OPEN_A), "utf8")).toBe(first);
  });

  it("never withdraws the round that names itself", async () => {
    const source = path.join(root, "source");
    await writeRound(source, newer([NEWER]));

    const result = await importRound({ source, roundsDir: dir });

    expect(result.superseded).toEqual([{ id: NEWER, outcome: "self" }]);
    expect(await statusOf(path.join(dir, NEWER))).toBe("open");
  });
});

describe("answering a round that supersedes others", () => {
  it("withdraws the open rounds it names once the answer is written", async () => {
    const manifestSha256 = await writeRound(path.join(dir, NEWER), newer([OPEN_B, SENT]));
    const ctx: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: SESSION_AUTH, ownerWrites: true };

    const { envelope } = await invokeCommand(roundsSubmitCommands({ dir })["rounds.submit"], { id: NEWER, manifestSha256, answers: KILN_ANSWERS }, ctx);

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", superseded: [{ id: OPEN_B, outcome: "withdrawn" }, { id: SENT, outcome: "kept-answered" }] } });
    expect(await statuses()).toEqual({ [OPEN_A]: "open", [OPEN_B]: "withdrawn", [SENT]: "sent", [NEWER]: "sent" });
  });
});

describe("rounds sweep, structural rule", () => {
  it("reports what it would withdraw in a dry run and writes nothing", async () => {
    await writeRound(path.join(dir, NEWER), newer([OPEN_A, SENT]));

    const report = await sweep({ apply: false });

    expect(report.superseded).toEqual([{ by: NEWER, targets: [{ id: OPEN_A, outcome: "would-withdraw" }, { id: SENT, outcome: "kept-answered" }] }]);
    expect(await exists(withdrawnOf(OPEN_A))).toBe(false);
  });

  it("withdraws with --apply, and a second sweep is a no-op", async () => {
    await writeRound(path.join(dir, NEWER), newer([OPEN_A]));

    const first = await sweep({ apply: true });
    const bytes = await readFile(withdrawnOf(OPEN_A), "utf8");
    const second = await sweep({ apply: true });

    expect(first.superseded).toEqual([{ by: NEWER, targets: [{ id: OPEN_A, outcome: "withdrawn" }] }]);
    expect(second.superseded).toEqual([{ by: NEWER, targets: [{ id: OPEN_A, outcome: "already-withdrawn" }] }]);
    expect(await readFile(withdrawnOf(OPEN_A), "utf8")).toBe(bytes);
  });
});

describe("rounds sweep, decisions rule", () => {
  const DECISIONS = [
    "# Decisions",
    `- 2026-10-20: ${OPEN_B} answered in chat: keep the staged climb`,
    `- 2026-10-20: ${OPEN_A} still waiting on the owner`,
    `- 2026-10-21: ${SENT} resolved`,
    "- 2026-10-21: kiln-b-r10 resolved",
  ];

  it("lists an open round the file cites as answered, with its line, and writes nothing without --apply", async () => {
    const decisionsFile = await writeDecisions(DECISIONS);

    const report = await sweep({ apply: false, decisionsFile });

    expect(report.decisions).toEqual({ file: decisionsFile, candidates: [{ id: OPEN_B, line: 2, text: DECISIONS[1], outcome: "would-withdraw" }] });
    expect(await exists(withdrawnOf(OPEN_B))).toBe(false);
    expect(await statuses()).toEqual({ [OPEN_A]: "open", [OPEN_B]: "open", [SENT]: "sent" });
  });

  it("withdraws the cited round as answered-elsewhere with --apply", async () => {
    const decisionsFile = await writeDecisions(DECISIONS);

    const report = await sweep({ apply: true, decisionsFile });

    expect(report.decisions?.candidates).toEqual([{ id: OPEN_B, line: 2, text: DECISIONS[1], outcome: "withdrawn" }]);
    expect(await reasonOf(OPEN_B)).toBe("answered-elsewhere");
    expect(await statuses()).toEqual({ [OPEN_A]: "open", [OPEN_B]: "withdrawn", [SENT]: "sent" });
  });

  it("refuses a decisions file it cannot read before writing anything", async () => {
    await writeRound(path.join(dir, NEWER), newer([OPEN_A]));

    const error: unknown = await sweep({ apply: true, decisionsFile: path.join(root, "missing.md") }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: EXIT.NOINPUT, message: expect.stringMatching(/^sweep refused: the decisions file/) });
    expect(await exists(withdrawnOf(OPEN_A))).toBe(false);
  });

  it("runs only the structural rule when no decisions file is named", async () => {
    expect(await sweep({ apply: false })).toEqual({ applied: false, superseded: [], decisions: null, gaps: [] });
  });
});

describe("titan-console rounds sweep", () => {
  it("prints one JSON report and leaves a dry run unwritten", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const decisionsFile = await writeDecisions([`- ${OPEN_B} answered`]);
    const consoleDir = path.join(import.meta.dirname, "..");
    const env = { ...process.env, TITAN_CONSOLE_STATE: root, TITAN_CONSOLE_ROUNDS_DIR: dir, TITAN_CONSOLE_HOST: "", TITAN_CONSOLE_DECISIONS_FILE: "" };

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["--import", "tsx", "server/cli.ts", "rounds", "sweep", "--json", "--decisions", decisionsFile], { cwd: consoleDir, env }, (err, out) =>
        err ? reject(err) : resolve(out),
      );
    });

    expect(JSON.parse(stdout)).toMatchObject({ applied: false, decisions: { candidates: [{ id: OPEN_B, outcome: "would-withdraw" }] } });
    expect(await exists(withdrawnOf(OPEN_B))).toBe(false);
  });
});

describe("rounds sweep argument parsing", () => {
  it.each([
    [["rounds", "sweep"], { apply: false, json: false, decisions: null }],
    [["rounds", "sweep", "--dry-run", "--json"], { apply: false, json: true, decisions: null }],
    [["rounds", "sweep", "--decisions", "d.md", "--apply"], { apply: true, json: false, decisions: "d.md" }],
    [["rounds", "sweep", "--apply", "--dry-run"], null],
    [["rounds", "sweep", "--apply", "--apply"], null],
    [["rounds", "sweep", "--decisions"], null],
    [["rounds", "sweep", "--decisions", "--json"], null],
    [["rounds", "sweep", "--decisions", "a", "--decisions", "b"], null],
    [["rounds", "sweep", "extra"], null],
    [["rounds", "withdraw", "--apply"], null],
  ])("reads %j as %j", (argv, expected) => {
    expect(roundsSweepArgs(argv)).toEqual(expected);
  });
});
