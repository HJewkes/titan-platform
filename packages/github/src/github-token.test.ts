import { describe, expect, it } from "vitest";
import { parseGitHubToken } from "./github-token.js";

const CLASSIC = `ghp_${"a1B2".repeat(9)}`;
const FINE_GRAINED = `github_pat_${"Ab1_".repeat(20)}`;

describe("parseGitHubToken", () => {
  it("accepts a 40-character classic token", () => {
    expect(CLASSIC).toHaveLength(40);
    expect(parseGitHubToken(CLASSIC)).toBe(CLASSIC);
  });

  it("accepts a fine-grained token and drops one trailing newline", () => {
    expect(parseGitHubToken(`${FINE_GRAINED}\n`)).toBe(FINE_GRAINED);
  });

  it.each([
    ["empty", ""],
    ["a short classic", CLASSIC.slice(0, 20)],
    ["a classic with a bad character", `${CLASSIC.slice(0, 39)}-`],
    ["an installation token prefix", `ghs_${"a".repeat(36)}`],
    ["two lines", `${CLASSIC}\n${CLASSIC}`],
    ["padding spaces", ` ${CLASSIC}`],
  ])("refuses %s without echoing it", (_name, text) => {
    let message = "";
    try {
      parseGitHubToken(text);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(CLASSIC.slice(4, 20));
    if (text.length > 8) expect(message).not.toContain(text);
  });
});
