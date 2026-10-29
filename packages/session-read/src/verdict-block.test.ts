import { describe, expect, it } from "vitest";
import { ciPolicyLabelledLines, parseVerdictBlock, refusedLines, visibleLines } from "./verdict-block.js";

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

  it("returns a distinct wait result for a WAIT block, with the PR and head it names, and never ok", () => {
    expect(parseVerdictBlock(block("WAIT"))).toEqual({ ok: false, reason: "wait", repo: "octo/demo", pr: 12, head: SHA, lineOffset: 0 });
  });

  it("refuses a WAIT block with a malformed head like any other verdict", () => {
    expect(refused(block("WAIT", "octo/demo#12", SHA.slice(0, 7)))).toBe("bad_head");
  });

  it("refuses a WAIT block beside a second Verdict line", () => {
    expect(refused(`${block("WAIT")}
${block()}`)).toBe("multiple_blocks");
  });

  it.each(["wait", "WAIT (checks pending)", "WAITING"])("leaves %s as bad_verdict, never a MERGE", (word) => {
    expect(refused(block(word))).toBe("bad_verdict");
  });

  it("leaves Verdict:WAIT without a space as bad_verdict", () => {
    expect(refused(`Verdict:WAIT\nPR: octo/demo#12\nHead: ${SHA}`)).toBe("bad_verdict");
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

  // Native-RegExp backtracking shows in no count, so the time limit is asserted only under `TITAN_BENCH=1` (TP-4264).
  it("parses a long single-line message in linear time", () => {
    const started = Date.now();
    expect(refused(`Verdict:${" ".repeat(200_000)}x`)).toBe("bad_verdict");
    expect(refused("a".repeat(500_000))).toBe("no_block");
    if (process.env.TITAN_BENCH === "1") expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("the optional Closer line", () => {
  const withCloser = (verdict: string, ...after: string[]) => [block(verdict), ...after].join("\n");
  const unchanged = { ok: true, verdict: "FIX_FIRST", repo: "octo/demo", pr: 12, head: SHA, lineOffset: 0 };

  it.each(["yes", "no"])("reads Closer: %s directly after Head on FIX_FIRST", (answer) => {
    expect(parseVerdictBlock(withCloser("FIX_FIRST", `Closer: ${answer}`))).toEqual({ ...unchanged, closer: answer });
  });

  it("leaves closer undefined when the line is absent", () => {
    expect(parseVerdictBlock(block("FIX_FIRST"))).toEqual(unchanged);
  });

  it("ignores a Closer line on MERGE", () => {
    const result = parseVerdictBlock(withCloser("MERGE", "Closer: yes"));
    expect(result).toEqual({ ...unchanged, verdict: "MERGE" });
  });

  it.each([
    ["another value", "Closer: maybe"],
    ["a capitalised value", "Closer: Yes"],
    ["trailing words", "Closer: yes please"],
    ["a duplicate", "Closer: yes\nCloser: no"],
    ["a duplicate further down", "Closer: no\nProse.\nCloser: no"],
    ["a gap after Head", "\nCloser: no"],
    ["prose between", "Note.\nCloser: no"],
    ["a quoted line", "> Closer: no"],
    ["an indented-code line", "    Closer: no"],
    ["a fenced line", "```\nCloser: no\n```"],
  ])("leaves verdict, PR and head unchanged for %s", (_name, tail) => {
    expect(parseVerdictBlock(withCloser("FIX_FIRST", tail))).toEqual(unchanged);
  });

  it("is not read when the line sits before the Verdict line", () => {
    expect(parseVerdictBlock(`Closer: no\n${block("FIX_FIRST")}`)).toEqual({ ...unchanged, lineOffset: 1 });
  });
});

describe("the optional CI-policy line", () => {
  const withLine = (verdict: string, ...after: string[]) => [block(verdict), ...after].join("\n");
  const merge = { ok: true, verdict: "MERGE", repo: "octo/demo", pr: 12, head: SHA, lineOffset: 0 };

  it("reads CI-policy: unchanged directly after Head on MERGE", () => {
    expect(parseVerdictBlock(withLine("MERGE", "CI-policy: unchanged"))).toEqual({ ...merge, ciPolicy: { kind: "unchanged" } });
  });

  it("reads every weakened key in order", () => {
    expect(parseVerdictBlock(withLine("MERGE", "CI-policy: weakened permissions, secrets"))).toEqual({
      ...merge, ciPolicy: { kind: "weakened", keys: ["permissions", "secrets"] },
    });
  });

  it.each(["required-check", "permissions", "pull_request_target", "secrets", "ruleset", "other"])("accepts the key %s", (key) => {
    expect(parseVerdictBlock(withLine("MERGE", `CI-policy: weakened ${key}`))).toEqual({
      ...merge, ciPolicy: { kind: "weakened", keys: [key] },
    });
  });

  it("leaves ciPolicy undefined when the line is absent", () => {
    expect(parseVerdictBlock(block("MERGE"))).toEqual(merge);
  });

  const malformed = { ...merge, ciPolicy: { kind: "malformed" } };
  const weakened = (...keys: string[]) => ({ ...merge, ciPolicy: { kind: "weakened", keys } });

  // Each spelling a reviewer could plausibly write: the label is read on raw lines, so none of them is ever absent.
  it.each([
    ["a fenced line", "```\nCI-policy: weakened secrets\n```"],
    ["a tilde-fenced line", "~~~\nCI-policy: weakened secrets\n~~~"],
    ["an unterminated fence after Head", "```\nCI-policy: weakened secrets"],
    ["a 4-space indent", "    CI-policy: weakened secrets"],
    ["a tab indent", "\tCI-policy: weakened secrets"],
    ["an HTML comment", "<!-- CI-policy: weakened secrets -->"],
    ["a multi-line HTML comment", "<!--\nCI-policy: weakened secrets\n-->"],
    ["a later fenced weakened after unchanged", "CI-policy: unchanged\n```\nCI-policy: weakened secrets\n```"],
    ["a heading", "## CI-policy: weakened secrets"],
    ["a slash", "CI/policy: weakened secrets"],
    ["a dot", "CI.policy: weakened secrets"],
    ["a table row", "| CI-policy | weakened secrets |"],
    ["no colon", "CI-policy weakened secrets"],
    ["a bold label", "**CI-policy:** weakened secrets"],
    ["an underscore-emphasised label", "__CI-policy__: weakened secrets"],
    ["a dash list marker", "- CI-policy: weakened secrets"],
    ["a star list marker", "* CI-policy: weakened secrets"],
    ["a numbered list marker", "1. CI-policy: weakened secrets"],
    ["a code span", "`CI-policy: weakened secrets`"],
    ["a quoted line", "> CI-policy: weakened secrets"],
    ["an en dash", "CI\u2013policy: weakened secrets"],
    ["an em dash", "CI\u2014policy: weakened secrets"],
    ["a non-breaking space", "CI\u00a0policy: weakened secrets"],
    ["a zero-width joiner", "CI-\u200dpolicy: weakened secrets"],
    ["a fullwidth colon", "CI-policy\uff1a weakened secrets"],
    ["a capitalised weakened", "CI-policy: Weakened secrets"],
    ["upper case throughout", "CI-POLICY: WEAKENED SECRETS"],
    ["a lower-case label", "ci-policy: weakened secrets"],
    ["a space before the colon", "CI-policy : weakened secrets"],
    ["a label spelt with a space", "CI policy: weakened secrets"],
    ["a blank line before", "\nCI-policy: weakened secrets"],
    ["a later lower-case weakened after unchanged", "CI-policy: unchanged\nProse.\nci-policy: weakened secrets"],
    ["a later spaced weakened after unchanged", "CI-policy: unchanged\nCI-policy : weakened secrets"],
    ["a bold label after a canonical unchanged", "CI-policy: unchanged\n**CI-policy:** weakened secrets"],
    ["a later unchanged after weakened", "CI-policy: weakened secrets\nProse.\nCI-policy: unchanged"],
    ["a malformed line beside a weakened one", "CI-policy: weakened secrets\nCI-policy: weakened branch-protection"],
  ])("reads weakened for %s", (_name, tail) => {
    expect(parseVerdictBlock(withLine("MERGE", tail))).toEqual(weakened("secrets"));
  });

  // Mutation guard: these spellings are invisible to visibleLines, so a label scan over visible lines fails the table.
  it.each([
    "```\nCI-policy: weakened secrets\n```",
    "```\nCI-policy: weakened secrets",
    "    CI-policy: weakened secrets",
    "<!--\nCI-policy: weakened secrets\n-->",
  ])("hides %j from visibleLines", (tail) => {
    expect(visibleLines(withLine("MERGE", tail)).filter((line) => line?.includes("policy"))).toEqual([]);
  });

  it("merges the keys of every weakened line, in first-seen order", () => {
    const tail = "CI-policy: weakened permissions\n```\n**CI-policy:** weakened secrets, permissions\n```";
    expect(parseVerdictBlock(withLine("MERGE", tail))).toEqual(weakened("permissions", "secrets"));
  });

  it("reads keys written without the comma-space separator", () => {
    expect(parseVerdictBlock(withLine("MERGE", "CI-policy: weakened secrets,ruleset"))).toEqual(weakened("secrets", "ruleset"));
  });

  it("reads a fenced weakened line that sits before the Verdict line", () => {
    const text = `\`\`\`\nCI-policy: weakened secrets\n\`\`\`\n${block("MERGE")}\nCI-policy: unchanged`;
    expect(parseVerdictBlock(text)).toEqual({ ...weakened("secrets"), lineOffset: 3 });
  });

  it("finds no block when an unterminated fence before the Verdict line hides it", () => {
    expect(parseVerdictBlock(`\`\`\`\n${block("MERGE")}\nCI-policy: unchanged`)).toEqual({ ok: false, reason: "no_block" });
  });

  it.each([
    ["an unknown key", "CI-policy: weakened branch-protection"],
    ["a known key beside an unknown one", "CI-policy: weakened required-check, tests"],
    ["a trailing note", "CI-policy: weakened secrets (see ci.yml)"],
    ["a duplicated key", "CI-policy: weakened secrets, secrets"],
    ["weakened with no key", "CI-policy: weakened"],
    ["weakened with a trailing space", "CI-policy: weakened "],
    ["a negated weakened", "CI-policy: not weakened"],
    ["a capitalised value", "CI-policy: Unchanged"],
    ["trailing words", "CI-policy: unchanged I think"],
    ["a duplicate", "CI-policy: unchanged\nCI-policy: unchanged"],
    ["the line one line late", "\nCI-policy: unchanged"],
    ["prose between", "Note.\nCI-policy: unchanged"],
    ["a bold unchanged", "**CI-policy:** unchanged"],
    ["a fenced unchanged", "```\nCI-policy: unchanged\n```"],
    ["an indented unchanged", "    CI-policy: unchanged"],
    ["an unchanged in an HTML comment", "<!-- CI-policy: unchanged -->"],
    ["an unchanged followed by a hidden unchanged", "CI-policy: unchanged\n<!-- CI-policy: unchanged -->"],
    ["prose that starts with the label", "CI policy changes look fine to me."],
  ])("reads as malformed for %s while the verdict still parses", (_name, tail) => {
    expect(parseVerdictBlock(withLine("MERGE", tail))).toEqual(malformed);
  });

  it.each([
    ["prose naming CI policies", "The CI policies look fine."],
    ["prose with the label mid-line", "Checked the CI-policy line twice."],
  ])("reads as missing for %s while the verdict still parses", (_name, tail) => {
    expect(parseVerdictBlock(withLine("MERGE", tail))).toEqual(merge);
  });

  // Synthetic equivalents of live review lines (tp#1544, tp#2443, tp#2456, tp#2474, tp#2487 r1/r2/r4/r5) that name a
  // ci-policy module: the label glued to an identifier character is a code name, not the reviewer's CI-policy line.
  it.each([
    ["tp#1544", "- `ci-policy-gate.test.ts:91` only checks the rule wording, which did not change."],
    ["tp#2487 r1", "- **`ci-policy-changes`.** The tab becomes two spaces before the ANSI strip now."],
    ["tp#2487 r2", "- **ci-policy-changes.**"],
    ["tp#2487 r4", "- **`ci-policy-changes.ts`:** tabs now become two spaces before escape sequences."],
    ["tp#2487 r5", "**ci-policy-changes:** the output is the same as before, except that tag characters go."],
    ["tp#2443 test file", "`ci-policy-changes.test.ts` checks the card text."],
    ["tp#2443 camel case", "- `ciPolicyChanges` is set only by the gate."],
    ["tp#2456 read module", "- **`ci-policy-read.ts`:** reads the base branch tip."],
    ["tp#2456 plain bullet", "- `ci-policy-changes.ts` is pure."],
    ["tp#2474", "- `ciPolicyAt` (`gate-brief.ts:90`) checks the head."],
  ])("reads unchanged when a %s line names a ci-policy identifier above the block", (_name, line) => {
    const text = `Review.\n\n${line}\n\n${withLine("MERGE", "CI-policy: unchanged")}`;
    expect(parseVerdictBlock(text)).toEqual({ ...merge, lineOffset: 4, ciPolicy: { kind: "unchanged" } });
  });

  it.each([
    ["a hyphen-glued weakened", "CI-policy-weakened: secrets"],
    ["a camel-case weakened", "ciPolicyWeakened secrets"],
    ["an underscore-glued weakened", "ci_policy_weakened secrets"],
    ["a dot-glued weakened", "`ci-policy.weakened` secrets"],
  ])("still reads weakened for %s glued to the label", (_name, tail) => {
    expect(parseVerdictBlock(withLine("MERGE", "CI-policy: unchanged", tail))).toEqual(weakened("secrets"));
  });

  it.each([
    ["a bold prose heading", "**CI policy:** nothing under .github/ changed."],
    ["a dotted bold heading", "**CI-policy.** Nothing under .github/ changed."],
    ["a label before a separate word", "- **ci-policy card:** compared old and new cleaning."],
  ])("still reads malformed for %s", (_name, tail) => {
    expect(parseVerdictBlock(withLine("MERGE", "CI-policy: unchanged", tail))).toEqual(malformed);
  });

  it("reads as malformed when the line sits before the Verdict line", () => {
    expect(parseVerdictBlock(`CI-policy: unchanged\n${block("MERGE")}`)).toEqual({ ...malformed, lineOffset: 1 });
  });

  it("is ignored on FIX_FIRST, where Closer still parses", () => {
    expect(parseVerdictBlock(withLine("FIX_FIRST", "Closer: yes", "CI-policy: weakened secrets"))).toEqual({
      ...merge, verdict: "FIX_FIRST", closer: "yes",
    });
  });

  it("is ignored on WAIT", () => {
    expect(parseVerdictBlock(withLine("WAIT", "CI-policy: unchanged"))).toEqual({
      ok: false, reason: "wait", repo: "octo/demo", pr: 12, head: SHA, lineOffset: 0,
    });
  });
});

describe("refusedLines", () => {
  const trailer = `${block()}\nCI-policy: unchanged`;

  it("reads a prose CI policy heading as malformed, quotes it, and reads MERGE once it is removed", () => {
    const heading = "**CI policy:** nothing under `.github/` changed in this PR.";
    const message = `Looked at it.\n\n${heading}\n\n${trailer}`;

    expect(parseVerdictBlock(message)).toMatchObject({ ok: true, ciPolicy: { kind: "malformed" } });
    expect(refusedLines(message, "ci_policy_malformed")).toEqual([heading]);
    expect(parseVerdictBlock(`Looked at it.\n\n${trailer}`)).toMatchObject({ ok: true, verdict: "MERGE", ciPolicy: { kind: "unchanged" } });
  });

  it("quotes a Verdict sentence in the body as the second block, and reads MERGE once it is removed", () => {
    const sentence = "Verdict: merge. The PR is docs-only and touches no code.";
    const message = `${sentence}\n\n${trailer}`;

    expect(refused(message)).toBe("multiple_blocks");
    expect(refusedLines(message, "multiple_blocks")).toEqual([sentence]);
    expect(refused(trailer)).toBe("accepted");
  });

  it("quotes the prose heading but not a line naming a ci-policy identifier", () => {
    const heading = "**CI policy:** nothing under `.github/` changed in this PR.";
    const message = `- \`ci-policy-changes.ts\` is pure.\n\n${heading}\n\n${trailer}`;

    expect(refusedLines(message, "ci_policy_malformed")).toEqual([heading]);
  });

  it("quotes every Verdict line when all of them are canonical", () => {
    expect(refusedLines(`${block()}\n${block("FIX_FIRST")}`, "multiple_blocks")).toEqual(["Verdict: MERGE", "Verdict: FIX_FIRST"]);
  });

  it("quotes nothing for another refusal", () => {
    expect(refusedLines(block(), "bad_head")).toEqual([]);
  });
});

describe("ciPolicyLabelledLines", () => {
  it("lists a decorated weakened line and the canonical unchanged line after it, each with its own reading", () => {
    const text = ["**CI policy:** weakened secrets", "", block("MERGE"), "CI-policy: unchanged"].join("\n");

    const lines = ciPolicyLabelledLines(text);

    expect(lines).toEqual([
      { raw: "**CI policy:** weakened secrets", reading: { kind: "weakened", keys: ["secrets"] } },
      { raw: "CI-policy: unchanged", reading: { kind: "unchanged" } },
    ]);
    expect(parseVerdictBlock(text)).toMatchObject({ ciPolicy: { kind: "weakened", keys: ["secrets"] } });
  });

  it("reads a prose unchanged line away from Head+1 as malformed, as the block does", () => {
    const text = ["CI-policy: unchanged", "", block("MERGE")].join("\n");

    expect(ciPolicyLabelledLines(text)).toEqual([{ raw: "CI-policy: unchanged", reading: { kind: "malformed" } }]);
    expect(parseVerdictBlock(text)).toMatchObject({ ciPolicy: { kind: "malformed" } });
  });

  it("lists nothing for text that is not one MERGE block", () => {
    expect(ciPolicyLabelledLines([block("FIX_FIRST"), "CI-policy: weakened secrets"].join("\n"))).toEqual([]);
    expect(ciPolicyLabelledLines("CI-policy: weakened secrets")).toEqual([]);
  });
});
