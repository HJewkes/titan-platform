import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MAP_PATH, diffFiles, forwardEdges, parseExternalImporters, parseImports, parseLsTree } from "./burndown-port-map.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "burndown-port-map.mjs");
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** An agent-chat stand-in whose burndown directory holds `names`, and a map that lists `mapped`. */
function sandbox(names, mapped) {
  const root = mkdtempSync(join(tmpdir(), "burndown-port-map-"));
  roots.push(root);
  const repo = join(root, "agent-chat");
  mkdirSync(join(repo, "src", "agents", "burndown"), { recursive: true });
  for (const name of names) writeFileSync(join(repo, "src", "agents", "burndown", name), "export {}\n");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "burndown");
  const map = join(root, "map.json");
  writeFileSync(map, JSON.stringify({ source: { sha: git("rev-parse", "HEAD").trim() }, files: mapped.map((file) => ({ file })) }));
  return { repo, map };
}

const runCheck = ({ repo, map }) => spawnSync(process.execPath, [SCRIPT, "check", "--agent-chat", repo, "--map", map], { encoding: "utf8" });

describe("burndown-port-map", () => {
  it("reports a subdirectory in the ls-tree listing apart from the files", () => {
    const output = "100644 blob aaa\tsrc/agents/burndown/a.ts\n040000 tree bbb\tsrc/agents/burndown/sub\n100644 blob ccc\tsrc/agents/burndown/LICENSE.x\n";

    expect(parseLsTree(output)).toEqual({ files: ["a.ts", "LICENSE.x"], subdirs: ["sub"] });
  });

  it("tells files the map lacks apart from entries git no longer lists", () => {
    expect(diffFiles(["kept.ts", "gone.ts"], ["kept.ts", "new.ts"])).toEqual({ unmapped: ["new.ts"], removed: ["gone.ts"] });
  });

  it("keeps sibling value and type imports and ignores imports that leave the directory", () => {
    const source = "import { a } from './a.js'\nimport type { B } from \"./b.js\"\nimport { c } from '../seats/c.js'\nconst d = await import('./d.js')\n";

    expect(parseImports(source)).toEqual(["a.ts", "b.ts", "d.ts"]);
  });

  it("collects non-test importers from git grep output", () => {
    const output = [
      "abc:src/agents/seats/run.ts:3:import { x } from '../burndown/plan.js'",
      "abc:src/__tests__/burndown-plan.test.ts:2:import { x } from '../agents/burndown/plan.js'",
      "abc:src/cli/verbs/burndown.ts:9:import { y } from '../../agents/burndown/seat-plan.js'",
    ].join("\n");

    const importers = parseExternalImporters(output);

    expect(Object.fromEntries([...importers].map(([k, v]) => [k, [...v]]))).toEqual({
      "plan.ts": ["src/agents/seats/run.ts"],
      "seat-plan.ts": ["src/cli/verbs/burndown.ts"],
    });
  });

  it("counts imports into a parallel or later slice as forward, and imports of L1 or an earlier slice as not", () => {
    const order = [["L1"], ["F1"], ["F2", "F3"], ["F4"]];
    const files = [
      { file: "f2.ts", dest: "F2", imports: ["f3.ts", "f4.ts", "l1.ts", "f1.ts", "other-f2.ts", "kept.ts"] },
      { file: "f3.ts", dest: "F3", imports: [] },
      { file: "f4.ts", dest: "F4", imports: ["f2.ts"] },
      { file: "f1.ts", dest: "F1", imports: [] },
      { file: "l1.ts", dest: "L1", imports: [] },
      { file: "other-f2.ts", dest: "F2", imports: [] },
      { file: "kept.ts", dest: "G-10", imports: [] },
    ];

    expect(forwardEdges(files, order).map((e) => e.to)).toEqual(["f3.ts", "f4.ts", "kept.ts"]);
  });

  it("pins the forward edges the committed map implies", () => {
    const map = JSON.parse(readFileSync(MAP_PATH, "utf8"));

    expect(forwardEdges(map.files, map.order)).toEqual(map.knownForwardEdges);
  });

  it("exits 1 when the burndown directory has a file the map lacks", () => {
    const result = runCheck(sandbox(["a.ts", "b.ts"], ["a.ts"]));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unmapped: b.ts");
  });

  it("exits 0 when the map lists exactly the burndown files", () => {
    const result = runCheck(sandbox(["a.ts", "b.ts"], ["a.ts", "b.ts"]));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 files, 2 mapped, 0 unmapped, 0 removed");
  });
});
