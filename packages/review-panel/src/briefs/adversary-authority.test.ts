import { describe, expect, it } from "vitest";
import { authorityLine } from "./adversary.js";

describe("authorityLine", () => {
  it.each(["unchanged", "tightened", "widened"] as const)("reads Authority: %s", (value) => {
    expect(authorityLine(`Probes: a -> b\nAuthority: ${value}\n\nVerdict: MERGE`)).toBe(value);
  });

  it("a missing Authority line reads undefined", () => {
    expect(authorityLine("Probes: a -> b\n\nVerdict: MERGE")).toBeUndefined();
  });

  it("an Authority line with another value reads malformed", () => {
    expect(authorityLine("Authority: unchanged, mostly")).toBe("malformed");
    expect(authorityLine("Authority:")).toBe("malformed");
    expect(authorityLine("Authority: Widened")).toBe("malformed");
  });

  it("a widened line hidden in a fence still reads widened", () => {
    expect(authorityLine("Authority: unchanged\n```\nAuthority: widened\n```")).toBe("widened");
  });

  it("two lines read the strictest, widened over unchanged", () => {
    expect(authorityLine("Authority: unchanged\nAuthority: widened")).toBe("widened");
    expect(authorityLine("Authority: tightened\nAuthority: unchanged")).toBe("unchanged");
    expect(authorityLine("Authority: unchanged\nAuthority: nonsense")).toBe("malformed");
  });
});
