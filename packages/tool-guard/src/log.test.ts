import { describe, expect, it } from "vitest";
import { formatDecisionLine, formatErrorLine, logPath } from "./log.js";
import type { DecisionLine } from "./log.js";

const ts = new Date("2026-01-02T03:04:05.000Z");

function line(overrides: Partial<DecisionLine> = {}): DecisionLine {
  return {
    ts,
    kind: "deny",
    rule: "SEC-CO",
    action: "secret-read",
    spelling: "bash.secret.cat",
    actor: ["coordinator", "worker", "headless"],
    actorId: "impl-7",
    session: "sess-1",
    tool: "Bash",
    toolUse: null,
    subject: { pattern: "home:.npmrc" },
    ...overrides,
  };
}

describe("formatDecisionLine", () => {
  it("writes the eleven fixed fields in order, tab separated", () => {
    expect(formatDecisionLine(line()).split("\t")).toEqual([
      "2026-01-02T03:04:05.000Z",
      "deny",
      "SEC-CO",
      "secret-read",
      "bash.secret.cat",
      "coordinator+worker+headless",
      "impl-7",
      "sess-1",
      "Bash",
      "-",
      "pattern=home:.npmrc",
    ]);
  });

  it("logs none for a deny that matched no rule", () => {
    expect(formatDecisionLine(line({ rule: null })).split("\t")[2]).toBe("none");
  });

  it("drops subject keys outside the safe set and cuts token-shaped values", () => {
    const fake = "zq" + "A1b2C3d4E5f6G7h8I9j0K1l2M3";

    const subject = formatDecisionLine(line({ subject: { host: `${fake}.example.test`, url: "https://example.test/x" } })).split("\t")[10];

    expect(subject).toBe("host=<cut>.example.test");
  });

  it("never lets a field break the line", () => {
    const out = formatDecisionLine(line({ actorId: "a\tb\nc", subject: { branch: "x\ty" } }));

    expect(out.split("\n")).toHaveLength(1);
    expect(out.split("\t")).toHaveLength(11);
  });
});

describe("formatErrorLine", () => {
  it("holds the error class, tool and session only", () => {
    expect(formatErrorLine({ ts, cls: "parse", tool: "Bash", session: null })).toBe("2026-01-02T03:04:05.000Z\terror\tparse\tBash\t-");
  });
});

describe("logPath", () => {
  it("prefers the explicit variable, then XDG state, then the home default", () => {
    expect(logPath({ TITAN_TOOL_GUARD_LOG: "/tmp/g.log" }, "/home/you")).toBe("/tmp/g.log");
    expect(logPath({ XDG_STATE_HOME: "/home/you/state" }, "/home/you")).toBe("/home/you/state/titan-tool-guard/guard.log");
    expect(logPath({}, "/home/you")).toBe("/home/you/.local/state/titan-tool-guard/guard.log");
  });
});
