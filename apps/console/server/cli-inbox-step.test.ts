import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "@titan-design/registry";
import { depositItemId, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { readAnswer, writeDeposit } from "@titan-design/owner-queue/spool";
import { inboxWithdrawArgs, inboxWithdrawCli } from "./cli-inbox.js";
import { resolveConfig, type ConsoleConfig } from "./config.js";

const ASKER = "seat-a";
const OPS = "seat-ops";
const ID = depositItemId(ASKER, "sit-1");

let root: string;
let config: ConsoleConfig;
let out: string[];
let err: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-cli-step-"));
  config = resolveConfig({ TITAN_CONSOLE_STATE: path.join(root, "state") }, root);
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => void err.push(line));
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

const sitting: OwnerItemDeposit = {
  depositId: "sit-1",
  asker: ASKER,
  kind: "do",
  door: "two-way",
  summary: "Terminal sitting",
  context: "Run in order.",
  steps: [
    { title: "First", command: "example-cli one" },
    { title: "Second", command: "example-cli two" },
  ],
};

async function run(argv: string[]): Promise<void> {
  const args = inboxWithdrawArgs(argv);
  if (args === null) throw new Error(`usage: ${argv.join(" ")}`);
  await inboxWithdrawCli(config, args);
}

describe("titan-console inbox step", () => {
  it("records each step and closes the sitting on the last one", async () => {
    await writeDeposit(config.inboxDir, sitting);

    await run(["inbox", "step", ID, "2", "--skipped", "--as", ASKER, "--actor", OPS]);
    await run(["inbox", "step", ID, "1", "--done", "--as", ASKER, "--actor", OPS, "--json"]);

    expect(process.exitCode).toBeUndefined();
    expect(out[0]).toBe(`${ID}\nstep 2: skipped (recorded)`);
    expect(JSON.parse(out[1]!)).toEqual({ id: ID, step: 1, outcome: "done", result: "recorded", closed: true });
    expect(await readAnswer(config.inboxDir, ID)).toMatchObject({ text: "sitting complete: 1 done, 1 skipped" });
  });

  it("exits 65 with one line for a step the sitting does not have", async () => {
    await writeDeposit(config.inboxDir, sitting);

    await run(["inbox", "step", ID, "3", "--done", "--as", ASKER, "--actor", OPS]);

    expect(process.exitCode).toBe(EXIT.DATAERR);
    expect(err).toEqual([`refused: step 3 is not one of ${ID}'s steps 1-2`]);
  });

  it("exits 65 when --actor is missing", async () => {
    await writeDeposit(config.inboxDir, sitting);

    await run(["inbox", "step", ID, "1", "--done", "--as", ASKER]);

    expect(process.exitCode).toBe(EXIT.DATAERR);
    expect(err).toEqual(["refused: --actor <seat> is required: name the seat running this"]);
  });

  it.each([
    ["no outcome", ["inbox", "step", ID, "1", "--as", ASKER, "--actor", OPS]],
    ["both outcomes", ["inbox", "step", ID, "1", "--done", "--skipped", "--as", ASKER, "--actor", OPS]],
    ["a step that is not a number", ["inbox", "step", ID, "one", "--done", "--as", ASKER, "--actor", OPS]],
    ["step zero", ["inbox", "step", ID, "0", "--done", "--as", ASKER, "--actor", OPS]],
    ["no step", ["inbox", "step", ID, "--done", "--as", ASKER, "--actor", OPS]],
    ["an outcome on withdraw", ["inbox", "withdraw", ID, "--done", "--reason", "obsolete", "--as", ASKER, "--actor", OPS]],
  ])("does not parse %s", (_label, argv) => {
    expect(inboxWithdrawArgs(argv)).toBeNull();
  });
});
