import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "@titan-design/registry";
import { decisionsFileArgs } from "./cli-rounds.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";

// Synthetic: kiln-schedule-r2 is a questions-only fixture round; the seat and initiative names are made up.
const ID = "kiln-schedule-r2";
const ROUND_JSON = path.join(FIXTURE_ROUNDS.dir, ID, "round.json");
const PORT = 7462;
const SPAWN_TIMEOUT_MS = 30_000;
const URL = `http://127.0.0.1:${PORT}/#/rounds/${ID}`;

let root: string;
let state: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-cli-decisions-"));
  state = path.join(root, "state");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the real bin with `stdin` piped in, the way a seat files a round. */
function runCli(args: string[], stdin: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  const consoleDir = path.join(import.meta.dirname, "..");
  const env = { ...process.env, AGENT_CHAT_NAME: "", TITAN_CONSOLE_PORT: String(PORT), TITAN_CONSOLE_STATE: state, TITAN_CONSOLE_HOST: "", TITAN_CONSOLE_ROUNDS_DIR: "", ...extraEnv };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "server/cli.ts", "decisions", "file", ...args], { cwd: consoleDir, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const roundsDirEntries = () => readdir(path.join(state, "rounds")).catch(() => []);
const askerOf = async (): Promise<unknown> => JSON.parse(await readFile(path.join(state, "rounds", ID, "asker.json"), "utf8"));

describe("titan-console decisions file", () => {
  it("files a round from stdin into the console's state dir and prints its id, asker and URL", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const result = await runCli(["-", "--seat", "sample-seat", "--initiative", "sample-initiative"], await readFile(ROUND_JSON, "utf8"));

    expect(result).toEqual({ code: 0, stdout: `${ID}\nasked by: sample-seat (sample-initiative)\n${URL}\n`, stderr: "" });
    expect(await roundsDirEntries()).toEqual([ID]);
    expect(await askerOf()).toMatchObject({ seat: "sample-seat", initiative: "sample-initiative" });
  });

  it("takes the seat from AGENT_CHAT_NAME and prints one JSON line with --json", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const result = await runCli(["--json"], await readFile(ROUND_JSON, "utf8"), { AGENT_CHAT_NAME: "second-seat" });

    expect(result.code).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({ id: ID, created: true, seat: "second-seat", initiative: null, url: URL, lanUrl: null });
  });

  it("reads the round from a file path", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const result = await runCli([ROUND_JSON, "--seat", "sample-seat"], "");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(URL);
    expect(await roundsDirEntries()).toEqual([ID]);
  });

  it("refuses a round that is not round@2 on stderr, with no URL and nothing written", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const result = await runCli(["--seat", "sample-seat"], JSON.stringify({ schema: "titan-review/round@1", unit: "x", round: 1 }));

    expect(result.code).toBe(EXIT.DATAERR);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^decision round refused: round\.json: /);
    expect(await roundsDirEntries()).toEqual([]);
  });

  it("refuses a round with no seat to name", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const result = await runCli([], await readFile(ROUND_JSON, "utf8"));

    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr).toMatch(/--seat <name>/);
    expect(await roundsDirEntries()).toEqual([]);
  });
});

describe("decisions file argument parsing", () => {
  const noEnv = {};
  it.each([
    [["decisions", "file"], { source: "-", seat: null, initiative: null, json: false }],
    [["decisions", "file", "-", "--seat", "s-1"], { source: "-", seat: "s-1", initiative: null, json: false }],
    [["decisions", "file", "--initiative", "i-1", "r.json", "--json", "--seat", "s-1"], { source: "r.json", seat: "s-1", initiative: "i-1", json: true }],
    [["decisions", "file", "a", "b"], null],
    [["decisions", "file", "--seat"], null],
    [["decisions", "file", "--seat", "--json"], null],
    [["decisions", "file", "--seat", "a", "--seat", "b"], null],
    [["decisions", "file", "--json", "--json"], null],
    [["decisions", "file", "--bogus"], null],
    [["decisions", "list"], null],
  ])("reads %j as %j", (argv, expected) => {
    expect(decisionsFileArgs(argv, noEnv)).toEqual(expected);
  });

  it("defaults the seat to AGENT_CHAT_NAME, and --seat wins over it", () => {
    expect(decisionsFileArgs(["decisions", "file"], { AGENT_CHAT_NAME: "env-seat" })?.seat).toBe("env-seat");
    expect(decisionsFileArgs(["decisions", "file", "--seat", "flag-seat"], { AGENT_CHAT_NAME: "env-seat" })?.seat).toBe("flag-seat");
  });
});
