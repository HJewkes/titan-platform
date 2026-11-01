import { describe, expect, it, vi } from "vitest";
import { diffCarry, serialiseDiff, type ExactDiffPin } from "./diff-hash.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

const TEXT = `diff --git a/f.ts b/f.ts
index ${A}..${B} 100644
--- a/f.ts
+++ b/f.ts
@@ -10,7 +10,7 @@ export function changedOnMain() {
 one

-two
+TWO
 three
`;

const BINARY = `diff --git a/x.bin b/x.bin
new file mode 100644
index ${"0".repeat(40)}..${B}
GIT binary patch
literal 6
NcmZQzWMXDu2LJ#7

literal 0
HcmV?d00001

`;

describe("serialiseDiff", () => {
  it("strips the whole @@ line and the text index line, and keeps context, blank lines and whitespace", () => {
    const { full, core } = serialiseDiff(TEXT);

    expect(full).toBe(["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", "@@", " one", " ", "-two", "+TWO", " three"].join("\n"));
    expect(core).toBe(["diff --git a/f.ts b/f.ts", "-two", "+TWO"].join("\n"));
  });

  it("reads a blank context line printed as an empty line the same as one printed as a space", () => {
    expect(serialiseDiff(TEXT.replace("\n \n", "\n\n"))).toEqual(serialiseDiff(TEXT));
  });

  it("keeps a binary's mode line and new blob id and drops its literal data", () => {
    const { full, core } = serialiseDiff(BINARY);

    expect(full).toBe(["diff --git a/x.bin b/x.bin", "new file mode 100644", `binary ${B}`].join("\n"));
    expect(core).toBe(full);
  });
});

const pin = (over: Partial<ExactDiffPin>): ExactDiffPin => ({ kind: "exact", head: A, base: B, main: B, full: "full", core: "core", ...over });

describe("diffCarry", () => {
  it("never asks for a merge-up proof when the reviewed lines changed", async () => {
    const mergeUp = vi.fn();

    const result = await diffCarry(pin({}), pin({ head: B, full: "other", core: "other" }), mergeUp);

    expect(result).toMatchObject({ carries: false });
    expect(mergeUp).not.toHaveBeenCalled();
  });

  it("refuses a core-equal head whose merge-up proof fails", async () => {
    const result = await diffCarry(pin({}), pin({ head: B, full: "other" }), () => Promise.resolve({ ok: false, reason: "not a merge" }));

    expect(result).toEqual({ carries: false, reason: "not a merge" });
  });

  it("refuses an ambiguous reviewed pin even when the hashes it would have had are equal", async () => {
    const result = await diffCarry({ kind: "ambiguous", head: A, main: B, bases: [A, B] }, pin({}), () => Promise.resolve({ ok: true, mainParent: B }));

    expect(result).toMatchObject({ carries: false });
  });
});
