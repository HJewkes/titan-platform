import { z } from "zod";
import { describe, expect, it } from "vitest";
import { jcs } from "./jcs.js";

describe("jcs", () => {
  it("jcs matches the RFC 8785 number vectors", () => {
    const vectors: [number, string][] = [
      [0, "0"],
      [-0, "0"],
      [1e21, "1e+21"],
      [1e23, "1e+23"],
      [1e-7, "1e-7"],
      [5e-324, "5e-324"],
      [1.7976931348623157e308, "1.7976931348623157e+308"],
      [333333333.3333333, "333333333.3333333"],
      [9007199254740992, "9007199254740992"],
      [2.9514790517935283e20, "295147905179352830000"],
      [9.999999999999997e22, "9.999999999999997e+22"],
      [4.5, "4.5"],
      [0.002, "0.002"],
    ];
    for (const [input, expected] of vectors) expect(jcs(input)).toBe(expected);
  });

  it("jcs sorts keys by UTF-16 code unit, as RFC 8785 §3.2.3's example orders them", () => {
    const input = { "\u20ac": "Euro", "\r": "CR", "\ufb33": "Hebrew", "1": "One", "\u{1F600}": "Emoji", "\u0080": "Control", "\u00f6": "o-diaeresis" };
    const order = [...jcs(input).matchAll(/"((?:[^"\\]|\\.)*)":"[^"]*"/g)].map((match) => z.string().parse(JSON.parse(`"${match[1]}"`)));
    expect(order).toEqual(["\r", "1", "\u0080", "\u00f6", "\u20ac", "\u{1F600}", "\ufb33"]);
    expect(jcs({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  it("jcs refuses NaN, Infinity and bigint rather than writing null", () => {
    expect(() => jcs(Number.NaN)).toThrow();
    expect(() => jcs({ a: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => jcs(1n)).toThrow();
    expect(() => jcs(() => 1)).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => jcs(cycle)).toThrow();
  });

  it("jcs omits an undefined member and keeps a null one", () => {
    expect(jcs({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
  });
});
