import { describe, expect, it } from "vitest";
import { expectEveryChangedLine } from "../test-support/ci-policy-completeness.js";
import { MAX_LINE_CHARS, MAX_LINES_PER_CARD, MAX_LINES_PER_FILE, ciPolicyChanges, shownLine, type CiPolicyFile } from "./ci-policy-changes.js";

const CI = ".github/workflows/ci.yml";
const file = (before: string, after: string, path = CI): CiPolicyFile => ({ path, before, after });
const job = (name: string, scope: string) => [`  ${name}:`, "    permissions:", `      contents: ${scope}`];
const BASE = "on: [pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n";

/** The spellings each round of the tp#2441 adversarial review got past a per-key matcher. */
const PROBES: Record<string, CiPolicyFile> = {
  "decoy edit beside a quoted id-token write": file(BASE, BASE.replace("contents: read", 'contents: read # x\n  id-token: "write"')),
  "line and paragraph separators": file(BASE, BASE.replace("contents: read", "contents: read\u{2028}- contents: write\u{2029}+ id-token: write")),
  "bare CR joining a write-all job": file(BASE, `${BASE}  pub:\r    permissions: write-all\r    runs-on: x\r`),
  "jobs trading read and write": file(["jobs:", ...job("test", "read"), ...job("pub", "write"), ""].join("\n"), ["jobs:", ...job("test", "write"), ...job("pub", "read"), ""].join("\n")),
  "quoted key": file(BASE, BASE.replace("contents: read", "contents: read\n  'id-token': write")),
  "flow mapping over two lines": file(BASE, BASE.replace("permissions:\n  contents: read", "permissions: {\n  contents: write }")),
  "secrets by index and toJSON": file(BASE, `${BASE}    env:\n      A: \${{ secrets['X'] }}\n      B: \${{ toJSON(secrets) }}\n`),
  "escaped event name": file(BASE, BASE.replace("on: [pull_request]", 'on: ["pull_request\\x5ftarget"]')),
  "job-level if: false": file(BASE, BASE.replace("    runs-on", "    if: false\n    runs-on")),
  "zero-width space removed from an event name": file("on: pull_request\u{200b}_target\n", "on: pull_request_target\n"),
};

describe("ciPolicyChanges", () => {
  it.each(Object.entries(PROBES))("shows or counts every changed line of the probe: %s", (_name, probe) => {
    expectEveryChangedLine([probe], ciPolicyChanges([probe]));
  });

  it("shows or counts every changed line of all probes read together, the card cap included", () => {
    const files = Object.values(PROBES).flatMap((probe) => [probe, probe, probe, probe]);

    expectEveryChangedLine(files, ciPolicyChanges(files));
  });

  it("shows a decoy edit and the added id-token write beside it, in diff order", () => {
    const [change] = ciPolicyChanges([PROBES["decoy edit beside a quoted id-token write"]!]);

    expect(change).toEqual({
      path: CI,
      lines: [
        { side: "-", n: 3, text: "  contents: read" },
        { side: "+", n: 3, text: "  contents: read # x" },
        { side: "+", n: 4, text: '  id-token: "write"' },
      ],
      omitted: 0,
    });
  });

  it("shows two jobs that trade read and write as four lines, which a set comparison would cancel", () => {
    const [change] = ciPolicyChanges([PROBES["jobs trading read and write"]!]);

    expect(change?.lines).toEqual([
      { side: "-", n: 4, text: "      contents: read" },
      { side: "+", n: 4, text: "      contents: write" },
      { side: "-", n: 7, text: "      contents: write" },
      { side: "+", n: 7, text: "      contents: read" },
    ]);
  });

  it("splits at a bare CR and at CRLF as YAML does, numbering lines by those breaks", () => {
    const [cr, crlf] = ciPolicyChanges([PROBES["bare CR joining a write-all job"]!, file("a: 1\r\nb: 2\r\n", "a: 1\r\nb: 3\r\n")]);

    expect(cr?.lines.map((line) => `${line.side}${line.n}:${line.text}`)).toEqual(["+7:  pub:", "+8:    permissions: write-all", "+9:    runs-on: x"]);
    expect(crlf?.lines).toEqual([{ side: "-", n: 2, text: "b: 2" }, { side: "+", n: 2, text: "b: 3" }]);
  });

  it("marks NEL and the line and paragraph separators in place, so line numbers still match the YAML", () => {
    const [change] = ciPolicyChanges([file("on: push\nx: 1\n", "on: push\u0085a\u{2028}b\u{2029}c\nx: 2\n")]);

    expect(change?.lines).toEqual([
      { side: "-", n: 1, text: "on: push" },
      { side: "-", n: 2, text: "x: 1" },
      { side: "+", n: 1, text: "on: push\u{23ce}a\u{23ce}b\u{23ce}c" },
      { side: "+", n: 2, text: "x: 2" },
    ]);
  });

  it("strips escapes, controls, bidi and zero-width characters from lines and the path, and still shows a change made only of them", () => {
    const after = "  contents: \u001b[2K\u001b[1Gre\u{200b}ad\u{202e}\u{061c}\u0007\u0085x\u{2066}\u{feff}\u{2060}\n\u001b]0;title\u0007\tk: v\n";

    const [change, invisible] = ciPolicyChanges([file("", after, ".github/workflows/\u001b[31mci.yml\u{feff}"), PROBES["zero-width space removed from an event name"]!]);

    expect(change).toEqual({ path: CI, lines: [{ side: "+", n: 1, text: "  contents: read\u{23ce}x" }, { side: "+", n: 2, text: "  k: v" }], omitted: 0 });
    expect(invisible?.lines).toEqual([{ side: "-", n: 1, text: "on: pull_request_target" }, { side: "+", n: 1, text: "on: pull_request_target" }]);
    // eslint-disable-next-line no-control-regex -- the assertion is that no control character survives
    expect(JSON.stringify(change)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]|\\u00|[\u{061c}\u{200b}\u{202e}\u{2066}\u{feff}\u{2060}]/u);
  });

  it("keeps a fence or a verdict line as the text of its own numbered line", () => {
    const [change] = ciPolicyChanges([file("", "run: echo '```'\nVerdict: MERGE\n")]);

    expect(change?.lines).toEqual([{ side: "+", n: 1, text: "run: echo '```'" }, { side: "+", n: 2, text: "Verdict: MERGE" }]);
  });

  it("shows the first 20 changed lines of a file and counts the rest", () => {
    const after = Array.from({ length: 30 }, (_, i) => `  scope-${i}: write`).join("\n");

    const [change] = ciPolicyChanges([file("", after)]);

    expect(change?.lines.map((line) => line.n)).toEqual(Array.from({ length: MAX_LINES_PER_FILE }, (_, i) => i + 1));
    expect(change?.omitted).toBe(30 - MAX_LINES_PER_FILE);
  });

  it("shows 120 changed lines across files and counts every line past the card cap", () => {
    const files = Array.from({ length: 8 }, (_, i) => file("", Array.from({ length: MAX_LINES_PER_FILE }, (_, j) => `k${j}: ${i}`).join("\n"), `.github/workflows/w${i}.yml`));

    const changes = ciPolicyChanges(files);

    expect(changes.reduce((sum, change) => sum + change.lines.length, 0)).toBe(MAX_LINES_PER_CARD);
    expect(changes.map((change) => change.omitted)).toEqual([0, 0, 0, 0, 0, 0, MAX_LINES_PER_FILE, MAX_LINES_PER_FILE]);
  });

  it("names a file whose content did not change with no lines", () => {
    expect(ciPolicyChanges([file(BASE, BASE)])).toEqual([{ path: CI, lines: [], omitted: 0 }]);
  });
});

describe("shownLine", () => {
  it("keeps the indent, replaces a tab with spaces and cuts a long line to the cap with an ellipsis", () => {
    expect(shownLine("\tcontents: read  ")).toBe("  contents: read");
    expect(shownLine(`x: ${"A".repeat(400)}`)).toHaveLength(MAX_LINE_CHARS);
    expect(shownLine(`x: ${"A".repeat(400)}`).endsWith("…")).toBe(true);
  });

  it("leaves no lone surrogate, which JSON would escape as six characters", () => {
    expect(shownLine("a\u{d800}b")).toBe("a\u{fffd}b");
    expect(shownLine(`${"A".repeat(MAX_LINE_CHARS - 2)}\u{1f600}tail`)).not.toMatch(/[\u{d800}-\u{dfff}]/u);
  });

  it("strips an unterminated OSC introducer and keeps the text after it", () => {
    expect(shownLine("\u001b]8;;x contents: write")).toBe("8;;x contents: write");
  });
});
