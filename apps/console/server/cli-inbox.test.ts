import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "@titan-design/registry";
import { depositItemId, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { readWithdrawal, WITHDRAW_LOG } from "@titan-design/owner-queue/withdraw";
import { inboxWithdrawArgs, inboxWithdrawCli } from "./cli-inbox.js";
import { resolveConfig, type ConsoleConfig } from "./config.js";

const ASKER = "seat-a";
const ID = depositItemId(ASKER, "d-1");
const OPS = "seat-ops";

let root: string;
let config: ConsoleConfig;
let out: string[];
let err: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-cli-inbox-"));
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

const deposit = (overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit => ({
  depositId: "d-1",
  asker: ASKER,
  kind: "do",
  door: "two-way",
  summary: "console update to bbbbbbb failed (smoke)",
  context: "aaaaaaa keeps serving.",
  keys: ["console-update"],
  ...overrides,
});

const auditRows = async (): Promise<unknown[]> =>
  (await readFile(path.join(config.inboxDir, WITHDRAW_LOG), "utf8")).trim().split("\n").map((line): unknown => JSON.parse(line));

async function run(argv: string[]): Promise<void> {
  const args = inboxWithdrawArgs(argv);
  if (args === null) throw new Error(`usage: ${argv.join(" ")}`);
  await inboxWithdrawCli(config, args);
}

describe("titan-console inbox withdraw and restore", () => {
  it("withdraws a deposit and records both its asker and the --actor seat", async () => {
    await writeDeposit(config.inboxDir, deposit());

    await run(["inbox", "withdraw", ID, "--reason", "resolved", "--as", ASKER, "--actor", OPS]);

    expect(process.exitCode).toBeUndefined();
    expect(out).toEqual([`${ID}\nwithdrawn`]);
    expect(await readWithdrawal(config.inboxDir, ID)).toMatchObject({ reason: "resolved", by: ASKER, actor: OPS });
  });

  it("restores a withdrawn deposit with --json", async () => {
    await writeDeposit(config.inboxDir, deposit());
    await run(["inbox", "withdraw", ID, "--reason", "obsolete", "--as", ASKER, "--actor", OPS]);

    await run(["inbox", "restore", "--json", ID, "--as", ASKER, "--actor", OPS]);

    expect(out.at(-1)).toBe(JSON.stringify({ id: ID, outcome: "restored" }));
    expect(await readWithdrawal(config.inboxDir, ID)).toBeUndefined();
    expect(await auditRows()).toEqual([expect.objectContaining({ op: "withdraw", by: ASKER, actor: OPS }), expect.objectContaining({ op: "restore", by: ASKER, actor: OPS })]);
  });

  it("exits 65 with one line and writes nothing when --actor is missing", async () => {
    await writeDeposit(config.inboxDir, deposit());

    const codes: (string | number | undefined)[] = [];
    for (const argv of [
      ["inbox", "withdraw", ID, "--reason", "obsolete", "--as", ASKER],
      ["inbox", "restore", ID, "--as", ASKER],
      ["inbox", "withdraw-matching", "--as", ASKER, "--key", "console-update", "--reason", "resolved"],
    ]) {
      process.exitCode = undefined;
      await run(argv);
      codes.push(process.exitCode);
    }

    expect(codes).toEqual([EXIT.DATAERR, EXIT.DATAERR, EXIT.DATAERR]);
    expect(err).toEqual(Array(3).fill("refused: --actor <seat> is required: name the seat running this"));
    expect(out).toEqual([]);
    expect(await readdir(config.inboxDir)).not.toContain(WITHDRAW_LOG);
  });

  it("exits 66 with one line for an id the spool does not hold", async () => {
    await run(["inbox", "withdraw", depositItemId(ASKER, "never-filed"), "--reason", "obsolete", "--as", ASKER, "--actor", OPS]);

    expect(process.exitCode).toBe(EXIT.NOINPUT);
    expect(err).toEqual([`not found: unknown id ${depositItemId(ASKER, "never-filed")}; full form is deposit:<32 hex>`]);
    expect(out).toEqual([]);
  });

  it("withdraws by a deposit:-prefixed short prefix and restores by a bare one, printing the full id", async () => {
    await writeDeposit(config.inboxDir, deposit());
    const hex = ID.slice("deposit:".length, "deposit:".length + 8);

    await run(["inbox", "withdraw", `deposit:${hex}`, "--reason", "obsolete", "--as", ASKER, "--actor", OPS]);
    await run(["inbox", "restore", hex, "--as", ASKER, "--actor", OPS]);

    expect(process.exitCode).toBeUndefined();
    expect(out).toEqual([`${ID}\nwithdrawn`, `${ID}\nrestored`]);
    expect(await auditRows()).toEqual([expect.objectContaining({ op: "withdraw", id: ID }), expect.objectContaining({ op: "restore", id: ID })]);
  });

  it("exits 65 and lists the full ids when a prefix matches more than one deposit", async () => {
    // These two depositIds were picked because their item ids share the first 8 hex digits.
    const ids = ["d-24352", "d-34741"].map((depositId) => depositItemId(ASKER, depositId)).sort();
    for (const depositId of ["d-24352", "d-34741"]) await writeDeposit(config.inboxDir, deposit({ depositId }));

    await run(["inbox", "withdraw", "e3a55b9e", "--reason", "obsolete", "--as", ASKER, "--actor", OPS]);

    expect(process.exitCode).toBe(EXIT.DATAERR);
    expect(err).toEqual([`refused: ambiguous id e3a55b9e matches ${ids.join(", ")}`]);
    expect(await readdir(config.inboxDir)).not.toContain(WITHDRAW_LOG);
  });

  it("exits 66 naming the full form for a short prefix no deposit starts", async () => {
    await writeDeposit(config.inboxDir, deposit());

    await run(["inbox", "restore", "00000000", "--as", ASKER, "--actor", OPS]);

    expect(process.exitCode).toBe(EXIT.NOINPUT);
    expect(err).toEqual(["not found: unknown id 00000000; full form is deposit:<32 hex>"]);
  });

  it("exits 65 with one line when another seat, a gate id or a bad reason asks", async () => {
    await writeDeposit(config.inboxDir, deposit());

    const codes: (string | number | undefined)[] = [];
    for (const argv of [
      ["inbox", "withdraw", ID, "--reason", "obsolete", "--as", "seat-b", "--actor", OPS],
      ["inbox", "withdraw", "gate:g-1", "--reason", "obsolete", "--as", ASKER, "--actor", OPS],
      ["inbox", "withdraw", ID, "--reason", "stale", "--as", ASKER, "--actor", OPS],
    ]) {
      process.exitCode = undefined;
      await run(argv);
      codes.push(process.exitCode);
    }

    expect(codes).toEqual([EXIT.DATAERR, EXIT.DATAERR, EXIT.DATAERR]);
    expect(err).toEqual([
      `refused: ${ID} was filed by seat-a, not seat-b`,
      "refused: gate:g-1 is not a deposit; only a seat's own deposits can be withdrawn",
      'refused: reason "stale" is not obsolete, resolved or superseded:<id>',
    ]);
    expect(await readWithdrawal(config.inboxDir, ID)).toBeUndefined();
  });
});

describe("titan-console inbox withdraw-matching", () => {
  it("lists the matching open deposits on a dry run, then withdraws them", async () => {
    await writeDeposit(config.inboxDir, deposit());
    await writeDeposit(config.inboxDir, deposit({ depositId: "d-2", keys: ["topic:cache"] }));

    await run(["inbox", "withdraw-matching", "--as", ASKER, "--actor", OPS, "--key", "console-update", "--key", "deploy-alarm", "--reason", "resolved", "--dry-run"]);
    await run(["inbox", "withdraw-matching", "--as", ASKER, "--actor", OPS, "--key", "console-update", "--reason", "resolved"]);

    expect(out).toEqual([`${ID}  console update to bbbbbbb failed (smoke)\nwould-withdraw: 1`, `${ID}  console update to bbbbbbb failed (smoke)\nwithdrawn: 1`]);
    expect(await readWithdrawal(config.inboxDir, depositItemId(ASKER, "d-2"))).toBeUndefined();
    expect(await auditRows()).toEqual([expect.objectContaining({ op: "withdraw", id: ID, by: ASKER, actor: OPS })]);
  });
});

describe("inbox withdraw argument parsing", () => {
  it.each([
    [["inbox", "withdraw", "deposit:x", "--reason", "resolved", "--as", "s", "--actor", "o"], { verb: "withdraw", id: "deposit:x", reason: "resolved", as: "s", actor: "o", json: false }],
    [["inbox", "restore", "--actor", "o", "--as", "s", "deposit:x", "--json"], { verb: "restore", id: "deposit:x", as: "s", actor: "o", json: true }],
    [["inbox", "withdraw-matching", "--as", "s", "--key", "a", "--key", "b", "--reason", "resolved", "--actor", "o"], { verb: "withdraw-matching", as: "s", actor: "o", keys: ["a", "b"], reason: "resolved", dryRun: false, json: false }],
    [["inbox", "withdraw", "deposit:x", "--reason", "resolved", "--as", "s"], { verb: "withdraw", id: "deposit:x", reason: "resolved", as: "s", actor: null, json: false }],
  ])("reads %j", (argv, expected) => {
    expect(inboxWithdrawArgs(argv)).toEqual(expected);
  });

  it.each([
    ["no --as", ["inbox", "withdraw", "deposit:x", "--reason", "resolved"]],
    ["no --reason", ["inbox", "withdraw", "deposit:x", "--as", "s"]],
    ["two ids", ["inbox", "withdraw", "deposit:x", "deposit:y", "--reason", "resolved", "--as", "s"]],
    ["--as twice", ["inbox", "withdraw", "deposit:x", "--reason", "resolved", "--as", "s", "--as", "t"]],
    ["--actor twice", ["inbox", "restore", "deposit:x", "--as", "s", "--actor", "o", "--actor", "p"]],
    ["--actor with no value", ["inbox", "withdraw", "deposit:x", "--reason", "resolved", "--as", "s", "--actor"]],
    ["a reason on restore", ["inbox", "restore", "deposit:x", "--as", "s", "--reason", "resolved"]],
    ["no --key", ["inbox", "withdraw-matching", "--as", "s", "--reason", "resolved"]],
    ["an unknown flag", ["inbox", "withdraw", "deposit:x", "--reason", "resolved", "--as", "s", "--force"]],
    ["inbox file", ["inbox", "file", "-"]],
  ])("refuses %s", (_, argv) => {
    expect(inboxWithdrawArgs(argv)).toBeNull();
  });
});
