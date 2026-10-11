import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanMemory } from "./discover.js";
import { fact, useTempHome, writeMemory, type TempHome } from "./home.fixture.js";

let temp: TempHome;

beforeEach(() => {
  temp = useTempHome();
});

afterEach(() => {
  temp.restore();
});

describe("scanMemory", () => {
  it("finds memory in ~/.claude and in a profile, tagged with each account", () => {
    writeMemory(path.join(temp.home, ".claude"), "p1", { "a.md": fact("a", "first", "body a") });
    writeMemory(path.join(temp.home, ".claude-profiles", "work"), "p2", { "b.md": fact("b", "second", "body b") });

    const scan = scanMemory();

    expect(scan.facts.map(({ ref }) => [ref.account, ref.project, path.basename(ref.path)])).toEqual([
      ["default", "p1", "a.md"],
      ["work", "p2", "b.md"],
    ]);
  });

  it("counts MEMORY.md as an index, not a fact", () => {
    writeMemory(path.join(temp.home, ".claude"), "p1", { "MEMORY.md": "- [A](a.md) — hook\n", "a.md": fact("a", "first", "body") });

    const scan = scanMemory();

    expect(scan.facts).toHaveLength(1);
    expect(scan.indexes.map((file) => path.basename(file))).toEqual(["MEMORY.md"]);
  });

  it("skips a symlinked memory directory", () => {
    const outside = writeMemory(path.join(temp.home, "elsewhere"), "x", { "secret.md": fact("s", "outside", "body") });
    const project = path.join(temp.home, ".claude", "projects", "p1");
    mkdirSync(project, { recursive: true });
    symlinkSync(outside, path.join(project, "memory"));

    const scan = scanMemory();

    expect(scan.facts).toEqual([]);
  });

  it("ignores a stray file beside the project directories", () => {
    writeMemory(path.join(temp.home, ".claude"), "p1", { "a.md": fact("a", "first", "body") });
    writeFileSync(path.join(temp.home, ".claude", "projects", ".DS_Store"), "");

    const scan = scanMemory();

    expect(scan.facts.map((f) => f.name)).toEqual(["a"]);
  });

  it("reports a file it cannot parse and keeps going", () => {
    writeMemory(path.join(temp.home, ".claude"), "p1", { "bad.md": "no frontmatter here", "good.md": fact("g", "good", "body") });

    const scan = scanMemory();

    expect(scan.facts.map((f) => f.name)).toEqual(["g"]);
    expect(scan.unparsed.map(({ ref }) => path.basename(ref.path))).toEqual(["bad.md"]);
  });
});
