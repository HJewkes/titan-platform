import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "@titan-design/registry";
import { importRoundCli, roundsImportArgs } from "./cli-rounds.js";
import { resolveConfig } from "./config.js";
import { roundFramesCommands } from "./round-frames.js";
import { roundsCommands } from "./rounds.js";

// Synthetic: the round@2 fixture round-import.test.ts imports.
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "import", "sample-batch-r2");
const ID = "sample-batch-r2";
const PORT = 7461;
const SPAWN_TIMEOUT_MS = 30_000;

let root: string;
let state: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-cli-rounds-"));
  state = path.join(root, "state");
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

const roundsDirEntries = () => readdir(path.join(state, "rounds")).catch(() => []);

/** Runs the real bin, the way the factory sweep will. */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const consoleDir = path.join(import.meta.dirname, "..");
  const env = { ...process.env, TITAN_CONSOLE_PORT: String(PORT), TITAN_CONSOLE_STATE: state, TITAN_CONSOLE_HOST: "", TITAN_CONSOLE_ROUNDS_DIR: "" };
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", "server/cli.ts", "rounds", "import", ...args], { cwd: consoleDir, env }, (err, stdout, stderr) =>
      resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe("titan-console rounds import", () => {
  it("prints the id, the frame count, the feedback outcome and the console URL", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const result = await runCli([FIXTURE]);

    expect(result).toEqual({ code: 0, stdout: `${ID}\nframes: 4\nfeedback: copied\nhttp://127.0.0.1:${PORT}/#/rounds/${ID}\n`, stderr: "" });
    expect(await roundsDirEntries()).toEqual([ID]);
  });

  it("prints exactly one JSON object with --json", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const result = await runCli(["--json", FIXTURE]);

    expect(result.code).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({ id: ID, created: true, frames: 4, feedback: "copied", url: `http://127.0.0.1:${PORT}/#/rounds/${ID}`, lanUrl: null });
  });

  it("refuses a symlinked source on stderr with no URL, a non-zero exit and nothing written", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const link = path.join(root, "linked-round");
    await symlink(FIXTURE, link);

    const result = await runCli([link]);

    expect(result.code).toBe(EXIT.NOINPUT);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^import refused: the source is not a directory/);
    expect(result.stderr).not.toContain("/#/rounds/");
    expect(await roundsDirEntries()).toEqual([]);
  });
});

describe("importRoundCli", () => {
  it("adds the LAN URL when the console listens on a LAN address", async () => {
    const lan = "192.0.2.7";
    const env = { TITAN_CONSOLE_STATE: state, TITAN_CONSOLE_PORT: String(PORT), TITAN_CONSOLE_HOST: lan, TITAN_CONSOLE_LAN_NAMES: "lan-box", TITAN_CONSOLE_TLS_CERT: "cert.pem", TITAN_CONSOLE_TLS_KEY: "key.pem" };
    const config = resolveConfig(env, root, "linux", { hostname: () => "lan-box", addresses: () => [lan] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const source = path.join(root, "round-2");
    await cp(FIXTURE, source, { recursive: true });

    await importRoundCli(config, { dir: source, json: false });

    expect(log).toHaveBeenCalledWith(`${ID}\nframes: 4\nfeedback: copied\nhttp://127.0.0.1:${PORT}/#/rounds/${ID}\nhttps://lan-box:${PORT}/#/rounds/${ID}`);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("rounds import argument parsing", () => {
  it.each([
    [["rounds", "import", "dir"], { dir: "dir", json: false }],
    [["rounds", "import", "dir", "--json"], { dir: "dir", json: true }],
    [["rounds", "import", "--json", "dir"], { dir: "dir", json: true }],
    [["rounds", "import"], null],
    [["rounds", "import", "a", "b"], null],
    [["rounds", "import", "--json", "--json"], null],
    [["rounds", "list", "dir"], null],
  ])("reads %j as %j", (argv, expected) => {
    expect(roundsImportArgs(argv)).toEqual(expected);
  });
});

describe("the import is not reachable over /rpc", () => {
  it("registers no rounds.import among the rounds commands", () => {
    const source = { dir: path.join(root, "rounds") };

    const names = [...Object.keys(roundsCommands(source)), ...Object.keys(roundFramesCommands(source))];

    expect(names).not.toContain("rounds.import");
    expect(names.filter((name) => /import/.test(name))).toEqual([]);
  });
});
