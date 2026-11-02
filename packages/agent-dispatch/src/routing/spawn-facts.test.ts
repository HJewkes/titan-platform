import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSpawnFacts } from "./node.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function activeWorkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-facts-"));
  dirs.push(root);
  return root;
}

function write(root: string, rel: string, text: string) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const TASK = ["id: EX-7", "title: Example task", "estimate: 3", "done_when: the example ships", "tags: [kind:feature]"];

const PLAN = [
  "# EX-7 plan",
  "```burndown-slices",
  JSON.stringify([
    { n: "a", title: "one", points: 1, owns: ["src/alpha/a.ts"] },
    { n: "b", title: "two", points: 2, owns: ["src/alpha/b.ts", "src/alpha/c.ts"] },
  ]),
  "```",
  "",
].join("\n");

function seeded(): string {
  const root = activeWorkRoot();
  write(root, "alpha/tasks/EX-7.yml", TASK.join("\n"));
  write(root, "alpha/sources/EX-7-plan.md", PLAN);
  return root;
}

describe("readSpawnFacts", () => {
  it("takes a named slice's owns and its points as the estimate", () => {
    const { facts, note } = readSpawnFacts(seeded(), "EX-7", "b");

    expect(facts).toEqual({
      estimate: 2,
      done_when: "the example ships",
      tags: ["kind:feature"],
      owns: ["src/alpha/b.ts", "src/alpha/c.ts"],
    });
    expect(note).toEqual({ source: "plan-slice", present: ["estimate", "done_when", "kind", "owns", "slice"] });
  });

  it("takes the union of owns and the task estimate without a slice", () => {
    const { facts, note } = readSpawnFacts(seeded(), "EX-7");

    expect(facts.estimate).toBe(3);
    expect(facts.owns).toEqual(["src/alpha/a.ts", "src/alpha/b.ts", "src/alpha/c.ts"]);
    expect(note.source).toBe("plan");
  });

  it("falls back to the spawn's own owns with no plan", () => {
    const root = activeWorkRoot();
    write(root, "alpha/tasks/EX-7.yml", TASK.join("\n"));

    const { facts, note } = readSpawnFacts(root, "EX-7", undefined, ["src/beta/x.ts"]);

    expect(facts.owns).toEqual(["src/beta/x.ts"]);
    expect(note).toEqual({ source: "req", present: ["estimate", "done_when", "kind", "owns"] });
  });

  it("folds a top-level kind field into a kind tag", () => {
    const root = activeWorkRoot();
    write(root, "alpha/tasks/EX-8.yml", "id: EX-8\nestimate: 1\nkind: docs\n");

    expect(readSpawnFacts(root, "EX-8").facts.tags).toEqual(["kind:docs"]);
  });

  it("gives empty facts with source none for an unknown id", () => {
    expect(readSpawnFacts(seeded(), "EX-404")).toEqual({ facts: { owns: [] }, note: { source: "none", present: [] } });
  });

  it("reads nothing for an id that is not a plain file name", () => {
    expect(readSpawnFacts(seeded(), "../alpha/tasks/EX-7").note.source).toBe("none");
  });

  it("reads the first initiative by name and marks a duplicate id ambiguous", () => {
    const root = seeded();
    write(root, "beta/tasks/EX-7.yml", "id: EX-7\nestimate: 9\n");

    const { facts, note } = readSpawnFacts(root, "EX-7");

    expect(facts.estimate).toBe(3);
    expect(note.ambiguous).toBe(true);
  });

  it("ignores a task field of the wrong type rather than failing", () => {
    const root = activeWorkRoot();
    write(root, "alpha/tasks/EX-9.yml", "id: EX-9\nestimate: big\ndone_when: ships\n");

    expect(readSpawnFacts(root, "EX-9").facts).toEqual({ done_when: "ships", tags: [], owns: [] });
  });
});
