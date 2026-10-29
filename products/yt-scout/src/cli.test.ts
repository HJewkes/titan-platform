import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => {
  vi.unstubAllEnvs();
  tree.cleanup();
});

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

describe("titan-yt-scout score", () => {
  it("scores a transcript through the injected runner and prints the total and cost", async () => {
    tree.write("watchlist.yml", VALID_WATCHLIST);
    tree.write("RUBRIC.md", "## The owner's system\n\nx\n\n## Scores\n\ny\n");
    tree.write("abc123def45.md", '---\ntitle: "Synthetic Talk"\n---\n\n[0:30] A technique.\n');
    const card = { actionable: 3, novelty: 3, evidence: 3, pain_points: [], summary: "s", techniques: [{ ts: "00:30", what: "w" }], caveat: "" };
    vi.stubEnv("TITAN_YT_SCOUT_CONFIG", path.join(tree.root, "watchlist.yml"));
    vi.stubEnv("TITAN_YT_SCOUT_DB", path.join(tree.root, "state", "scout.sqlite3"));
    vi.stubEnv("YT_ROOT", tree.root);

    const code = await runCli(
      ["score", "abc123def45", "--transcript", path.join(tree.root, "abc123def45.md"), "--rubric", path.join(tree.root, "RUBRIC.md")],
      (l) => out.push(l),
      (l) => err.push(l),
      async () => ({ ok: true, value: { output: card, costUsd: 0.05, inputTokens: 1, outputTokens: 1, model: "model-a" } }),
    );

    expect(code).toBe(0);
    expect(out).toEqual(["scored abc123def45: 9/15, $0.0500"]);
  });
});
