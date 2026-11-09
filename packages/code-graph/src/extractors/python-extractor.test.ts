import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { workingTreeSource, type IndexSource } from "../index-source.js";
import { PythonGraphExtractor } from "./python-extractor.js";
import type { GraphFragment } from "../types.js";

const ROOT = path.resolve("/synthetic-repo");
const TREE = ["requests/__init__.py", "requests/sessions.py", "requests/compat.py"];

function treeSource(): IndexSource {
  const present = new Set(TREE.map((rel) => path.join(ROOT, rel)));
  return { ...workingTreeSource(), fileExists: (abs) => present.has(abs) };
}

const SESSIONS = [
  "import os",
  "import os.path",
  "from collections.abc import Mapping",
  "import urllib3",
  "from charset_normalizer.api import from_bytes",
  "from .compat import cookielib",
  "from ..constants import DEFAULT_TIMEOUT",
  "from .missing import helper",
  "",
].join("\n");

async function extractSessions(): Promise<GraphFragment> {
  const file = await parseFile(SESSIONS, path.join(ROOT, "requests/sessions.py"), "python");
  const [fragment] = new PythonGraphExtractor(ROOT, treeSource()).extract(file);
  if (!fragment) throw new Error("python extractor returned no fragment");
  return fragment;
}

describe("PythonGraphExtractor imports in a requests-like package (TP-307)", () => {
  it("files stdlib imports under python: and third-party imports under pypi:, never npm:", async () => {
    const fragment = await extractSessions();

    const externals = fragment.nodes.filter((n) => n.kind === "external").map((n) => n.id);

    expect(externals.sort()).toEqual(["pypi:charset_normalizer", "pypi:urllib3", "python:collections", "python:os"]);
  });

  it("links a resolved relative import to its file and drops an unresolved one", async () => {
    const fragment = await extractSessions();

    const targets = fragment.edges.filter((e) => e.kind === "imports").map((e) => e.dstId);

    expect(targets.sort()).toEqual([
      "pypi:charset_normalizer",
      "pypi:urllib3",
      "python:collections",
      "python:os",
      "requests/compat.py",
    ]);
  });
});
