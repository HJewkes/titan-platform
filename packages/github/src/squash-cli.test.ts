import { describe, expect, it } from "vitest";
import { runSquashCli } from "./squash-cli.js";

const INPUT = {
  title: "Add the widget",
  body: "Adds the widget.",
  prNumber: 7,
  taskIds: ["TP-1"],
  commits: [{ subject: "Add the widget", body: "" }],
};

const EXPECTED_BODY = "## Summary\n\nAdds the widget.\n\n## Changes\n\n- **Add the widget.**\n\nRefs: TP-1, #7";

function run(args: string[], stdin: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = runSquashCli(args, {
    readStdin: () => stdin,
    out: (text) => (out += text),
    err: (line) => (err += `${line}\n`),
  });
  return { code, out, err };
}

describe("titan-squash-message", () => {
  it("prints the full commit message for JSON on stdin", () => {
    const result = run([], JSON.stringify(INPUT));

    expect(result).toEqual({ code: 0, out: `Add the widget (TP-1) (#7)\n\n${EXPECTED_BODY}\n`, err: "" });
  });

  it("prints subject and body as JSON with --json", () => {
    const result = run(["--json"], JSON.stringify(INPUT));

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ subject: "Add the widget (TP-1) (#7)", body: EXPECTED_BODY });
  });

  it("exits 2 naming the field when the input has the wrong shape", () => {
    const result = run([], JSON.stringify({ ...INPUT, commits: [{ subject: 3 }] }));

    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("commits[0].subject");
  });

  it("exits 2 when stdin is not JSON", () => {
    const result = run([], "not json");

    expect(result.code).toBe(2);
    expect(result.err).toContain("stdin is not valid JSON");
  });

  it("exits 2 on an unknown flag", () => {
    const result = run(["--yaml"], JSON.stringify(INPUT));

    expect(result.code).toBe(2);
    expect(result.err).toContain("usage: titan-squash-message");
  });
});
