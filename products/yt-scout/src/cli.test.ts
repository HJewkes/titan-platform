import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CONFIG, runCli } from "./cli.js";
import { tempTree, VALID_WATCHLIST, writeSeenTree, type TempTree } from "./fixtures.test-helpers.js";

let tree: TempTree;
let out: string[];
let err: string[];

const run = (...argv: string[]) =>
  runCli(
    argv,
    (l) => out.push(l),
    (l) => err.push(l),
  );

beforeEach(() => {
  tree = tempTree();
  out = [];
  err = [];
});
afterEach(() => tree.cleanup());

describe("titan-yt-scout config check", () => {
  it("reports the sources of a valid watch list", async () => {
    tree.write("watchlist.yml", VALID_WATCHLIST);

    const code = await run("config", "check", "--config", path.join(tree.root, "watchlist.yml"));

    expect(code).toBe(0);
    expect(out).toEqual([expect.stringMatching(/^ok: 3 sources, \d on trial/)]);
  });

  it("exits non-zero naming the file and line of an unknown key", async () => {
    tree.write("watchlist.yml", `${VALID_WATCHLIST}surprise: 1\n`);
    const file = path.join(tree.root, "watchlist.yml");

    const code = await run("config", "check", "--config", file);

    expect(code).toBe(EXIT_CONFIG);
    expect(err).toEqual([`${file}:21: surprise: unknown key`]);
  });
});

describe("titan-yt-scout seen import", () => {
  it("imports the seen-set into the given database and is a no-op on rerun", async () => {
    writeSeenTree(tree);
    tree.write("scout/watchlist.yml", VALID_WATCHLIST);
    const args = ["seen", "import", "--root", tree.root, "--config", path.join(tree.root, "scout/watchlist.yml"), "--db", path.join(tree.root, "state/scout.sqlite3")];

    expect(await run(...args)).toBe(0);
    expect(await run(...args)).toBe(0);

    expect(out[1]).toBe("inserted 8, upgraded 0, unchanged 0");
    expect(out[4]).toBe("inserted 0, upgraded 0, unchanged 8");
    expect(out[5]).toBe("videos by state: mined 1, scored 3, seen 3, transcribed 1");
  });
});
