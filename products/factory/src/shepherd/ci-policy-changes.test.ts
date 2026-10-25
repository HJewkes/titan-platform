import { describe, expect, it } from "vitest";
import { expectEveryChangedLine } from "../test-support/ci-policy-completeness.js";
import { MAX_LINE_CHARS, ciPolicyChanges, shownLine, type CiPolicyFile } from "./ci-policy-changes.js";

const CI = ".github/workflows/ci.yml";
const file = (before: string, after: string, path = CI): CiPolicyFile => ({ path, before, after });
const job = (name: string, scope: string) => [`  ${name}:`, "    permissions:", `      contents: ${scope}`];
const BASE = "on: [pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n";

/** The spellings each round of the tp#2441 adversarial review got past a per-key matcher. */
const PROBES: Record<string, CiPolicyFile> = {
  "decoy edit beside a quoted id-token write": file(BASE, BASE.replace("contents: read", 'contents: read # x\n  id-token: "write"')),
  "line and paragraph separators": file(BASE, BASE.replace("contents: read", "contents: read\u{2028}- contents: write\u{2029}+ id-token: write")),
  "bare CR joining a write-all job": file(BASE, `${BASE}  pub:\r    permissions: write-all\r    runs-on: x\r`),
  "CRLF breaks": file("a: 1\r\nb: 2\r\n", "a: 1\r\nb: 3\r\n"),
  "jobs trading read and write": file(["jobs:", ...job("test", "read"), ...job("pub", "write")].join("\n"), ["jobs:", ...job("test", "write"), ...job("pub", "read")].join("\n")),
  "quoted key": file(BASE, BASE.replace("contents: read", "contents: read\n  'id-token': write")),
  "flow mapping over two lines": file(BASE, BASE.replace("permissions:\n  contents: read", "permissions: {\n  contents: write }")),
  "secrets by index and toJSON": file(BASE, `${BASE}    env:\n      A: \${{ secrets['X'] }}\n      B: \${{ toJSON(secrets) }}\n`),
  "escaped event name": file(BASE, BASE.replace("on: [pull_request]", 'on: ["pull_request\\x5ftarget"]')),
  "job-level if: false": file(BASE, BASE.replace("    runs-on", "    if: false\n    runs-on")),
  "fence and verdict lines": file(BASE, `${BASE}    run: echo '\`\`\`'\nVerdict: MERGE\n`),
};

describe("ciPolicyChanges", () => {
  it.each(Object.entries(PROBES))("shows or counts every changed line of the probe: %s", (_name, probe) => {
    expectEveryChangedLine([probe], ciPolicyChanges([probe]));
  });

  it("shows or counts every changed line of all probes read together, the card cap included", () => {
    const files = Object.values(PROBES).flatMap((probe) => Array.from({ length: 6 }, () => probe));

    expectEveryChangedLine(files, ciPolicyChanges(files));
  });

  it("marks NEL and the line and paragraph separators in place, so line numbers still match the YAML", () => {
    const [change] = ciPolicyChanges([file("x: 0\ny: 1\n", "x: 0\u0085a\u{2028}b\u{2029}c\ny: 1\n")]);

    expect(change?.lines).toEqual([{ side: "-", n: 1, text: "x: 0" }, { side: "+", n: 1, text: "x: 0\u{23ce}a\u{23ce}b\u{23ce}c" }]);
  });

  it("strips escapes, controls, bidi and zero-width characters from lines and the path, and still shows a change made only of them", () => {
    const after = "  contents: \u001b[2K\u001b[1Gre\u{200b}ad\u{202e}\u{061c}\u0007x\u{2066}\u{feff}\u{2060}\n\u001b]0;title\u0007\tk: v\n";

    const [change, invisible] = ciPolicyChanges([file("", after, ".github/workflows/\u001b[31mci.yml\u{feff}"), file("on: pull_request\u{200b}_target\n", "on: pull_request_target\n")]);

    expect(change).toEqual({ path: CI, lines: [{ side: "+", n: 1, text: "  contents: readx" }, { side: "+", n: 2, text: "  k: v" }], omitted: 0 });
    expect(invisible?.lines).toEqual([{ side: "-", n: 1, text: "on: pull_request_target" }, { side: "+", n: 1, text: "on: pull_request_target" }]);
  });

  it("strips tag characters and soft hyphens, which hide text the owner would otherwise approve unseen", () => {
    const [change] = ciPolicyChanges([file("", "  contents: re\u00adad\u{e0001}\u{e0077}\u{e0072}\u{e0069}\u{e0074}\u{e0065}\n")]);

    expect(change?.lines).toEqual([{ side: "+", n: 1, text: "  contents: read" }]);
  });

  it("shows 20 changed lines per file and 120 across files, and counts the rest", () => {
    const files = Array.from({ length: 8 }, (_, i) => file("", Array.from({ length: 25 }, (_, j) => `k${j}: ${i}`).join("\n"), `.github/w${i}.yml`));

    const changes = ciPolicyChanges(files);

    expect(changes.map((change) => change.lines.length)).toEqual([20, 20, 20, 20, 20, 20, 0, 0]);
    expect(changes.map((change) => change.omitted)).toEqual([5, 5, 5, 5, 5, 5, 25, 25]);
  });
});

describe("shownLine", () => {
  it("keeps the indent, replaces a tab, strips an unterminated OSC introducer and cuts at the cap with an ellipsis", () => {
    expect(shownLine("\tcontents: read  ")).toBe("  contents: read");
    expect(shownLine("\u001b]8;;x write")).toBe("8;;x write");
    expect(shownLine(`x: ${"A".repeat(400)}`)).toMatch(new RegExp(`^.{${MAX_LINE_CHARS - 1}}…$`, "u"));
  });

  it("leaves no lone surrogate, which JSON would escape as six characters", () => {
    expect(shownLine("a\u{d800}b")).toBe("a\u{fffd}b");
    expect(shownLine(`${"A".repeat(MAX_LINE_CHARS - 2)}\u{1f600}tail`)).not.toMatch(/[\u{d800}-\u{dfff}]/u);
  });
});
