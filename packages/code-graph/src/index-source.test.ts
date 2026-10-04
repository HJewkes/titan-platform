import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystemHost } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workingTreeSource, type IndexSource } from "./index-source.js";
import { readSnapshot, runIndex } from "./incremental.test-helpers.js";
import { openCodeGraph } from "./store.js";

// One file per read site: an extensionless import (ts-morph host), a dist import
// remapped to src, a Python import, and a .gitattributes-generated file.
const FIXTURE: Record<string, string> = {
  ".gitattributes": "src/client.ts linguist-generated\n",
  "src/a.ts": "export const A = 1;\n",
  "src/b.ts": 'import { A } from "./a";\nimport { helper } from "../lib/dist/index.js";\nexport const B = helper(A);\n',
  "src/client.ts": "export const client = {};\n",
  "lib/src/index.ts": "export function helper(n: number): number {\n  return n;\n}\n",
  "lib/dist/index.d.ts": "export declare function helper(n: number): number;\n",
  "py/app.py": "import util\n\nutil.run()\n",
  "py/util.py": "def run():\n    return 1\n",
};

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-source-"));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    await fs.mkdir(path.dirname(path.join(rootDir, rel)), { recursive: true });
    await fs.writeFile(path.join(rootDir, rel), content);
  }
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

async function indexWith(source: IndexSource | undefined) {
  const store = openCodeGraph(":memory:");
  try {
    const result = await runIndex(store, rootDir, { incremental: false, ...(source && { source }) });
    return readSnapshot(store, result.snapshotId);
  } finally {
    store.close();
  }
}

/** Records every path a source is asked about, ts-morph host calls included. */
function recordingSource(inner: IndexSource) {
  const seen = { listed: 0, read: [] as string[], exists: [] as string[], host: [] as string[] };
  const host = inner.fileSystem;
  const fileSystem = new Proxy(host, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (typeof args[0] === "string") seen.host.push(args[0]);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as FileSystemHost;
  const source: IndexSource = {
    listFiles: (roots, languages) => {
      seen.listed += 1;
      return inner.listFiles(roots, languages);
    },
    readFile: (abs) => (seen.read.push(abs), inner.readFile(abs)),
    fileExists: (abs) => (seen.exists.push(abs), inner.fileExists(abs)),
    fileSystem,
  };
  return { source, seen };
}

const endsWith = (paths: readonly string[], rel: string) => paths.some((p) => p.endsWith(rel));

describe("IndexSource", () => {
  it("indexes identically with and without an explicit working-tree source", async () => {
    const implicit = await indexWith(undefined);
    const explicit = await indexWith(workingTreeSource());

    expect(explicit).toEqual(implicit);
    expect(implicit.edges.some((e) => e.includes('"dstId":"lib/src/index.ts"'))).toBe(true);
    expect(implicit.edges.some((e) => e.includes('"dstId":"py/util.py"'))).toBe(true);
    expect(implicit.nodes.some((n) => n.includes('"id":"src/client.ts"') && n.includes('"role":"generated"'))).toBe(true);
  });

  it("reads every walk, file, existence check and ts-morph lookup through the given source", async () => {
    const { source, seen } = recordingSource(workingTreeSource());

    await indexWith(source);

    expect(seen.listed).toBe(1);
    expect(endsWith(seen.read, "/src/b.ts")).toBe(true);
    expect(endsWith(seen.read, "/.gitattributes")).toBe(true);
    expect(endsWith(seen.exists, "/lib/src/index.ts")).toBe(true);
    expect(endsWith(seen.exists, "/py/util.py")).toBe(true);
    expect(endsWith(seen.host, "/src/a.ts")).toBe(true);
  });
});
