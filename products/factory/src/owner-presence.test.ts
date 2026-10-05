import { describe, expect, it } from "vitest";
import { confirmOwner, defaultHelperPath, helperSearchOrder, ROOT_HELPER_PATH, type HelperRunner, type StatPort } from "./owner-presence.js";

const helperPath = "/synthetic/owner-presence";
const PROOF = "0b6f2c1e-6f1d-4c3a-9e1b-2d4c6a8e0f13";
const OWNER = 501;
const FILE = 0o100755;
const DIR = 0o040755;
const LINK = 0o120755;

type Entry = { uid: number; mode: number };

/** A fake filesystem: `/`, `/synthetic` and the helper, owned and clean unless overridden. */
function fakeStat(overrides: Record<string, Entry | undefined> = {}): StatPort {
  const entries: Record<string, Entry | undefined> = { "/": { uid: 0, mode: DIR }, "/synthetic": { uid: OWNER, mode: DIR }, [helperPath]: { uid: OWNER, mode: FILE }, ...overrides };
  return (path) => entries[path];
}

async function confirmWith(stat: StatPort, helperPaths: readonly string[] = [helperPath]) {
  const runs: string[] = [];
  const reports: string[] = [];
  const run: HelperRunner = async (file) => (runs.push(file), PROOF);
  const proof = await confirmOwner("resolve gate", { run, stat, getuid: () => OWNER, helperPaths, report: (line) => reports.push(line) });
  return { proof, runs, reports };
}

describe("confirmOwner", () => {
  it("returns the proof the helper prints on success", async () => {
    const run: HelperRunner = async () => `${PROOF}\n`;
    expect(await confirmOwner("resolve gate", { run, stat: fakeStat(), getuid: () => OWNER, helperPaths: [helperPath] })).toBe(PROOF);
  });

  it.each([["a word", "proof-1234"], ["an uppercase UUID", PROOF.toUpperCase()], ["a UUID and more", `${PROOF} ok`], ["a non-v4 UUID", PROOF.replace("-4c3a-", "-1c3a-")]])(
    "refuses %s as a proof",
    async (_name, printed) => {
      const run: HelperRunner = async () => `${printed}\n`;
      expect(await confirmOwner("resolve gate", { run, stat: fakeStat(), getuid: () => OWNER, helperPaths: [helperPath] })).toBeUndefined();
    },
  );

  it("runs the helper from native/build beside this package, whatever the environment says", async () => {
    const build = defaultHelperPath();
    const files: string[] = [];
    const run: HelperRunner = async (file) => (files.push(file), PROOF);
    const stat: StatPort = (path) => (path === ROOT_HELPER_PATH ? undefined : { uid: OWNER, mode: path === build ? FILE : DIR });
    process.env.OWNER_PRESENCE_HELPER = "/synthetic/stub";
    try {
      await confirmOwner("resolve gate", { run, stat, getuid: () => OWNER });
    } finally {
      delete process.env.OWNER_PRESENCE_HELPER;
    }
    expect(files).toEqual([build]);
    expect(build).toMatch(/products\/factory\/native\/build\/owner-presence$/);
  });

  it("returns undefined when the owner cancels", async () => {
    const run: HelperRunner = async () => {
      throw Object.assign(new Error("Command failed"), { code: 1 });
    };
    expect(await confirmOwner("resolve gate", { run, stat: fakeStat(), getuid: () => OWNER, helperPaths: [helperPath] })).toBeUndefined();
  });

  it("returns undefined when the helper succeeds but prints no proof", async () => {
    const run: HelperRunner = async () => "\n";
    expect(await confirmOwner("resolve gate", { run, stat: fakeStat(), getuid: () => OWNER, helperPaths: [helperPath] })).toBeUndefined();
  });

  it("escapes control characters in the reason", async () => {
    const seen: string[][] = [];
    const run: HelperRunner = async (_file, args) => {
      seen.push([...args]);
      return PROOF;
    };
    await confirmOwner("approve\x1b[2J‮ and\\more", { run, stat: fakeStat(), getuid: () => OWNER, helperPaths: [helperPath] });
    expect(seen).toEqual([["approve\\x1b[2J\\u202E and\\\\more"]]);
  });
});

describe("confirmOwner checks the helper path before each run", () => {
  it("runs a helper the owner owns on a path nobody else can write", async () => {
    const { proof, runs, reports } = await confirmWith(fakeStat());
    expect(proof).toBe(PROOF);
    expect(runs).toEqual([helperPath]);
    expect(reports).toEqual([]);
  });

  it("runs a root-owned helper", async () => {
    const { proof } = await confirmWith(fakeStat({ "/synthetic": { uid: 0, mode: DIR }, [helperPath]: { uid: 0, mode: FILE } }));
    expect(proof).toBe(PROOF);
  });

  it.each([
    ["a group-writable helper", { [helperPath]: { uid: OWNER, mode: 0o100775 } }, `${helperPath} is group or other writable`],
    ["an other-writable parent directory", { "/synthetic": { uid: OWNER, mode: 0o040757 } }, "/synthetic is group or other writable"],
    ["a symlinked helper", { [helperPath]: { uid: OWNER, mode: LINK } }, `${helperPath} is a symlink`],
    ["a symlinked parent directory", { "/synthetic": { uid: OWNER, mode: LINK } }, "/synthetic is a symlink"],
    ["a helper owned by another uid", { [helperPath]: { uid: 502, mode: FILE } }, `${helperPath} is owned by uid 502, not root or uid ${OWNER}`],
    ["a parent owned by another uid", { "/": { uid: 502, mode: DIR } }, `/ is owned by uid 502, not root or uid ${OWNER}`],
    ["a helper that is a directory", { [helperPath]: { uid: OWNER, mode: DIR } }, `${helperPath} is not a regular file`],
    ["a missing helper", { [helperPath]: undefined }, `no helper at ${helperPath}`],
  ])("refuses %s without running it, naming the offending component", async (_name, overrides, reason) => {
    const { proof, runs, reports } = await confirmWith(fakeStat(overrides));
    expect(proof).toBeUndefined();
    expect(runs).toEqual([]);
    expect(reports).toEqual([`owner presence refused: ${reason}\n`]);
  });

  it("refuses when there is no OS user id to compare owners against", async () => {
    const runs: string[] = [];
    const run: HelperRunner = async (file) => (runs.push(file), PROOF);
    const proof = await confirmOwner("resolve gate", { run, stat: fakeStat(), getuid: () => undefined, helperPaths: [helperPath], report: () => {} });
    expect(proof).toBeUndefined();
    expect(runs).toEqual([]);
  });

  it("prefers the root install and never falls back to native/build when that install fails the check", async () => {
    const stat: StatPort = (path) => (path === ROOT_HELPER_PATH ? { uid: OWNER, mode: 0o100777 } : { uid: OWNER, mode: path === defaultHelperPath() ? FILE : DIR });
    const { proof, runs, reports } = await confirmWith(stat, helperSearchOrder());
    expect(proof).toBeUndefined();
    expect(runs).toEqual([]);
    expect(reports).toEqual([`owner presence refused: ${ROOT_HELPER_PATH} is group or other writable\n`]);
  });

  it("runs the root install when it exists and passes", async () => {
    const stat: StatPort = (path) => ({ uid: 0, mode: path === ROOT_HELPER_PATH ? FILE : DIR });
    const { runs } = await confirmWith(stat, helperSearchOrder());
    expect(runs).toEqual([ROOT_HELPER_PATH]);
  });
});
