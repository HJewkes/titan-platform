import { describe, expect, it } from "vitest";
import { parseVerdictBlock } from "./verdict-block.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const block = (verdict = "MERGE", pr = "octo/demo#12", head = SHA) =>
  `Verdict: ${verdict}\nPR: ${pr}\nHead: ${head}`;
const refused = (text: string) => {
  const result = parseVerdictBlock(text);
  return result.ok ? "accepted" : result.reason;
};

describe("parseVerdictBlock", () => {
  it("reads a block on the first line", () => {
    expect(parseVerdictBlock(block())).toEqual({
      ok: true, verdict: "MERGE", repo: "octo/demo", pr: 12, head: SHA, lineOffset: 0,
    });
  });

  it("finds a block after prose and reports its line offset", () => {
    const result = parseVerdictBlock(`Reviewed.\n\nAll fine.\n${block("FIX_FIRST")}\nThanks`);
    expect(result).toMatchObject({ ok: true, verdict: "FIX_FIRST", lineOffset: 3 });
  });

  it("ignores a Status line before the block and works without one", () => {
    expect(parseVerdictBlock(`Status: DONE\n${block()}`)).toMatchObject({ ok: true, lineOffset: 1 });
  });

  it("reads CRLF line endings", () => {
    expect(parseVerdictBlock(block().replace(/\n/g, "\r\n") + "\r\n")).toMatchObject({ ok: true, head: SHA });
  });

  it("trims leading and trailing whitespace on each line", () => {
    expect(parseVerdictBlock(`  Verdict: MERGE  \n  PR: octo/demo#12 \n   Head: ${SHA}\t`)).toMatchObject({ ok: true });
  });

  it("refuses text with no block", () => {
    expect(refused("Looks good to me")).toBe("no_block");
  });

  it("refuses two blocks, even identical ones", () => {
    expect(refused(`${block()}\n\n${block()}`)).toBe("multiple_blocks");
    expect(refused(`${block()}\n${block("FIX_FIRST")}`)).toBe("multiple_blocks");
  });

  it("refuses a valid block next to a second Verdict line", () => {
    expect(refused(`Verdict: APPROVE\n${block()}`)).toBe("multiple_blocks");
  });

  it.each(["APPROVE", "CHANGES", "merge", "MERGE now", "MERGEX"])("refuses verdict %s", (word) => {
    expect(refused(block(word))).toBe("bad_verdict");
  });

  it("refuses a short head", () => {
    expect(refused(block("MERGE", "octo/demo#12", SHA.slice(0, 39)))).toBe("bad_head");
    expect(refused(block("MERGE", "octo/demo#12", SHA.slice(0, 7)))).toBe("bad_head");
  });

  it("refuses a head with 41 or more hex characters", () => {
    expect(refused(block("MERGE", "octo/demo#12", `${SHA}a`))).toBe("bad_head");
  });

  it("refuses a head with trailing text", () => {
    expect(refused(block("MERGE", "octo/demo#12", `${SHA} (rebased)`))).toBe("bad_head");
  });

  it("refuses an upper-case head", () => {
    expect(refused(block("MERGE", "octo/demo#12", SHA.toUpperCase()))).toBe("bad_head");
  });

  it("refuses a head with a non-hex character", () => {
    expect(refused(block("MERGE", "octo/demo#12", `${SHA.slice(0, 39)}g`))).toBe("bad_head");
  });

  it.each([
    "octo/demo.git#12",
    "https://github.com/octo/demo/pull/12",
    "octo/demo12",
    "octo/demo#0",
    "octo/demo#012",
    "octo/demo#x",
    "octo/demo#12abc",
    "octo/demo#-1",
    "octo/demo#99999999999999999999",
    "demo#12",
    "octo/de mo#12",
    "oc$to/demo#12",
    "octo/dé#12",
    "../demo#12",
    "octo/..#12",
  ])("refuses PR ref %s", (ref) => {
    expect(refused(block("MERGE", ref))).toBe("bad_pr");
  });

  it("accepts dots, dashes and underscores in owner and name", () => {
    expect(parseVerdictBlock(block("MERGE", "my-org/re_po.v2#7"))).toMatchObject({ ok: true, repo: "my-org/re_po.v2", pr: 7 });
  });

  it("refuses a block missing its PR or Head line", () => {
    expect(refused(`Verdict: MERGE\nHead: ${SHA}`)).toBe("missing_pr_line");
    expect(refused("Verdict: MERGE\nPR: octo/demo#12")).toBe("missing_head_line");
    expect(refused("Verdict: MERGE")).toBe("missing_pr_line");
  });

  it("refuses lines that are not consecutive", () => {
    expect(refused(`Verdict: MERGE\n\nPR: octo/demo#12\nHead: ${SHA}`)).toBe("missing_pr_line");
    expect(refused(`Verdict: MERGE\nPR: octo/demo#12\nStatus: DONE\nHead: ${SHA}`)).toBe("missing_head_line");
  });

  it("does not count a block quoted in a markdown quote", () => {
    const quoted = block().split("\n").map((line) => `> ${line}`).join("\n");
    expect(refused(quoted)).toBe("no_block");
    expect(parseVerdictBlock(`${quoted}\n\n${block("FIX_FIRST")}`)).toMatchObject({ ok: true, verdict: "FIX_FIRST" });
  });

  it("does not count a block inside a code fence", () => {
    expect(refused(`\`\`\`\n${block()}\n\`\`\``)).toBe("no_block");
    expect(refused(`~~~text\n${block()}\n~~~`)).toBe("no_block");
    expect(parseVerdictBlock(`\`\`\`\n${block()}\n\`\`\`\n${block("FIX_FIRST")}`)).toMatchObject({
      ok: true, verdict: "FIX_FIRST", lineOffset: 5,
    });
  });

  describe("fences follow CommonMark", () => {
    const own = block("FIX_FIRST");
    it("keeps a block fenced when a shorter closer follows a 4-backtick opener", () => {
      expect(refused(`\`\`\`\`\nfoo\n\`\`\`\n${block()}`)).toBe("no_block");
    });
    it("keeps a block fenced when backticks try to close a tilde fence", () => {
      expect(refused(`~~~\nfoo\n\`\`\`\n${block()}`)).toBe("no_block");
    });
    it("keeps a block fenced when tildes try to close a backtick fence", () => {
      expect(refused(`\`\`\`\nfoo\n~~~\n${block()}`)).toBe("no_block");
    });
    it("closes a fence with a longer closer of the same character", () => {
      expect(parseVerdictBlock(`\`\`\`\nfoo\n\`\`\`\`\`\n${own}`)).toMatchObject({ ok: true, verdict: "FIX_FIRST", lineOffset: 3 });
      expect(parseVerdictBlock(`~~~\nfoo\n~~~~\n${own}`)).toMatchObject({ ok: true, lineOffset: 3 });
    });
    it("keeps everything after an unclosed fence fenced", () => {
      expect(refused(`\`\`\`\nfoo\n${block()}`)).toBe("no_block");
    });
    it("does not close a fence on a closer line that carries text", () => {
      expect(refused(`\`\`\`\n\`\`\` text\n${block()}`)).toBe("no_block");
    });
    it("does not close a fence on a closer indented 4 or more spaces", () => {
      expect(refused(`\`\`\`\n    \`\`\`\n${block()}`)).toBe("no_block");
    });
  });

  describe("indentation", () => {
    it("reads a block indented 3 spaces", () => {
      expect(parseVerdictBlock(`   Verdict: MERGE\n   PR: octo/demo#12\n   Head: ${SHA}`)).toMatchObject({ ok: true });
    });
    it("does not read a block indented 4 spaces or a tab", () => {
      expect(refused(block().replace(/^/gm, "    "))).toBe("no_block");
      expect(refused(block().replace(/^/gm, "\t"))).toBe("no_block");
    });
    it("refuses a block whose PR or Head line is indented 4 spaces", () => {
      expect(refused(`Verdict: MERGE\n    PR: octo/demo#12\nHead: ${SHA}`)).toBe("missing_pr_line");
      expect(refused(`Verdict: MERGE\nPR: octo/demo#12\n    Head: ${SHA}`)).toBe("missing_head_line");
    });
    it("still reads an own block beside an indented one", () => {
      expect(parseVerdictBlock(`${block().replace(/^/gm, "    ")}\n\n${block("FIX_FIRST")}`)).toMatchObject({ ok: true, verdict: "FIX_FIRST" });
    });
  });

  describe("HTML comments", () => {
    it("ignores a block inside a multi-line comment", () => {
      expect(refused(`<!--\n${block()}\n-->`)).toBe("no_block");
      expect(refused(`<!-- note\n${block()}\nmore -->`)).toBe("no_block");
    });
    it("ignores a block whose Verdict line opens on a comment line", () => {
      expect(refused(`<!-- Verdict: MERGE -->\nPR: octo/demo#12\nHead: ${SHA}`)).toBe("no_block");
    });
    it("ignores a block inside a one-line comment", () => {
      expect(refused(`<!-- ${block().replace(/\n/g, " ")} -->`)).toBe("no_block");
    });
    it("keeps everything after an unclosed comment hidden", () => {
      expect(refused(`<!-- start\n${block()}`)).toBe("no_block");
    });
    it("reads a block after the comment closed", () => {
      expect(parseVerdictBlock(`<!-- note -->\n<!--\nx\n-->\n${block()}`)).toMatchObject({ ok: true, lineOffset: 4 });
    });
    it("does not treat comment markers inside a fence as a comment", () => {
      expect(parseVerdictBlock(`\`\`\`\n<!--\n\`\`\`\n${block()}`)).toMatchObject({ ok: true, lineOffset: 3 });
    });
  });

  describe("containers and reopened constructs hide the block", () => {
    const b = block();
    it("hides a block inside a fence opened after a list marker", () => {
      expect(refused(`- \`\`\`\n  ${b.replace(/\n/g, "\n  ")}\n  \`\`\``)).toBe("no_block");
      expect(refused(`1. \`\`\`\n${b}\n\`\`\``)).toBe("no_block");
      expect(refused(`* ~~~\n${b}\n~~~`)).toBe("no_block");
    });
    it("hides a block inside a fence opened after a blockquote marker", () => {
      expect(refused(`> \`\`\`\n${b}\n\`\`\``)).toBe("no_block");
      expect(refused(`>\`\`\`\n${b}\n\`\`\``)).toBe("no_block");
    });
    it("hides a block inside a fence opened after nested container markers", () => {
      expect(refused(`> - 2) \`\`\`\n${b}\n\`\`\``)).toBe("no_block");
    });
    it("still reads a block after a fence opened in a list item closes", () => {
      expect(parseVerdictBlock(`- \`\`\`\nx\n\`\`\`\n${b}`)).toMatchObject({ ok: true, lineOffset: 3 });
    });
    it("does not open a fence on a list line that only mentions backticks", () => {
      expect(parseVerdictBlock(`- use \`\`\`code\`\`\` here\n${b}`)).toMatchObject({ ok: true, lineOffset: 1 });
    });
    it("keeps a comment open when its closing line reopens one", () => {
      expect(refused(`<!--\nx --> <!-- y\n${b}\n-->`)).toBe("no_block");
    });
    it("closes a comment whose closing line holds a later closer only", () => {
      expect(parseVerdictBlock(`<!--\nx --> y --> z\n${b}`)).toMatchObject({ ok: true, lineOffset: 2 });
    });
    it("does not read a block indented 4 non-breaking spaces or other Unicode spaces", () => {
      expect(refused(b.replace(/^/gm, "\u00a0".repeat(4)))).toBe("no_block");
      expect(refused(b.replace(/^/gm, "\u2003".repeat(4)))).toBe("no_block");
      expect(refused(b.replace(/^/gm, " \u00a0 \u00a0"))).toBe("no_block");
    });
    it("reads a block indented 3 non-breaking spaces", () => {
      expect(parseVerdictBlock(b.replace(/^/gm, "\u00a0".repeat(3)))).toMatchObject({ ok: true });
    });
  });

  it("parses a long single-line message in linear time", () => {
    const started = Date.now();
    refused(`Verdict:${" ".repeat(200_000)}x`);
    refused("a".repeat(500_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
