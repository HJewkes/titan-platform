import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMemoryFile, parseMemoryIndex } from "./parse.js";

const TOP_LEVEL_TYPE = `---
name: run-lint-first
description: Run the linter before pushing
type: feedback
---

Run pnpm lint before every push.
`;

const NESTED_TYPE = `---
name: run-lint-first
description: Run the linter before pushing
metadata:
  type: feedback
  modified: 2026-01-02
---

Run pnpm lint before every push.
`;

const NESTED_UNTYPED = `---
name: audit-naming
description: Audit names are not slop
metadata:
  node_type: memory
  pinned: false
  originSessionId: 00000000-0000-0000-0000-000000000000
  modified: 2026-01-03T04:05:06Z
---

Names in the audit are deliberate.
`;

describe("parseMemoryFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-auto-parse-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function parseFixture(file: string, raw: string) {
    const path = join(dir, file);
    writeFileSync(path, raw);
    return parseMemoryFile(readFileSync(path, "utf8"), { account: "default", project: "p1", path });
  }

  it("reads the type from the top level, from metadata, or falls back to unknown", () => {
    const types = [parseFixture("a.md", TOP_LEVEL_TYPE), parseFixture("b.md", NESTED_TYPE), parseFixture("c.md", NESTED_UNTYPED)].map(
      (result) => (result.ok ? result.type : result.error),
    );
    expect(types).toEqual(["feedback", "feedback", "unknown"]);
  });

  it("keeps name, description, body and the metadata modified stamp", () => {
    const result = parseFixture("b.md", NESTED_TYPE);
    expect(result).toMatchObject({ ok: true, name: "run-lint-first", description: "Run the linter before pushing", body: "Run pnpm lint before every push.", modified: "2026-01-02" });
  });

  it("gives the same content hash to facts that differ only in case and whitespace", () => {
    const [a, b] = [parseFixture("a.md", TOP_LEVEL_TYPE), parseFixture("b.md", TOP_LEVEL_TYPE.replace("Run pnpm lint", "run   PNPM lint"))];
    expect(a.ok && b.ok && a.contentHash === b.contentHash).toBe(true);
  });

  it("round-trips a quoted description that contains escaped quotes", () => {
    const raw = `---\nname: quoted\ndescription: "Say \\"merge\\" only after review: it's final"\ntype: user\n---\nBody\n`;
    expect(parseFixture("q.md", raw)).toMatchObject({ ok: true, description: `Say "merge" only after review: it's final` });
  });

  it("returns a failure naming the file when the frontmatter never closes", () => {
    const result = parseFixture("open.md", "---\nname: open\ntype: user\nBody with no close\n");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(join(dir, "open.md"));
  });

  it("returns a failure instead of throwing on invalid YAML", () => {
    const result = parseFixture("bad.md", "---\nname: [unclosed\ndescription: x\n---\nBody\n");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("invalid frontmatter YAML") });
  });
});

describe("parseMemoryIndex", () => {
  it("returns each pointer line with its 1-based line number and skips prose", () => {
    const raw = [
      "- [Lint first](run-lint-first.md) — run the linter before pushing",
      "- [Audit names](audit-naming.md) — names are deliberate",
      "Some prose the harness wrote.",
      "- [Owner](user-owner.md) — who the owner is",
      "- [CI](ci.md)",
      "- [Release](release.md) — how releases go",
    ].join("\n");
    expect(parseMemoryIndex(raw).map(({ file, line }) => [file, line])).toEqual([
      ["run-lint-first.md", 1],
      ["audit-naming.md", 2],
      ["user-owner.md", 4],
      ["ci.md", 5],
      ["release.md", 6],
    ]);
  });
});
