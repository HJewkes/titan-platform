import { describe, expect, it } from "vitest";
import { countWork, expectLinearWork, expectWorkPerChar } from "./work-count.js";

const text = `${"a".repeat(1000)}b`;

describe("the work count", () => {
  it("weighs a search by the characters it read, to its match or to the end", async () => {
    expect(await countWork(() => text.indexOf("b"))).toBe(1001);
    expect(await countWork(() => text.indexOf("z"))).toBe(1001);
    expect(await countWork(() => text.indexOf("b", 900))).toBe(101);
  });

  it("weighs a regex by the characters up to the end of its match", async () => {
    expect(await countWork(() => /b/.exec(text))).toBe(1001);
    const sticky = /a/y;
    sticky.lastIndex = 10;

    expect(await countWork(() => sticky.exec(text))).toBe(1);
  });

  it("counts a regex replace through the exec it calls, since the patched exec is what the spec looks up", async () => {
    expect(await countWork(() => text.replace(/b/g, "c"))).toBeGreaterThanOrEqual(1001);
  });

  it("counts a character read or a slice as one", async () => {
    expect(await countWork(() => [text.charCodeAt(0), text.slice(1)])).toBe(2);
  });

  it("puts every primitive back afterwards", async () => {
    const before = String.prototype.indexOf;

    await countWork(() => text.indexOf("b"));

    expect(String.prototype.indexOf).toBe(before);
  });

  it("fails on an assertion past its cap, even when the code under test catches the stop", async () => {
    const swallowing = () => {
      for (let i = 0; i < 100; i++) {
        try {
          text.indexOf("b");
        } catch {
          // The hook catches every error and denies.
        }
      }
    };

    await expect(countWork(swallowing, 5_000)).rejects.toMatchObject({ name: "AssertionError" });
    expect(String.prototype.indexOf).toBe(Object.getPrototypeOf("").indexOf);
  });

  it("passes the error the code under test throws on, under its cap", async () => {
    await expect(
      countWork(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("bounds work per character of the input", async () => {
    await expect(expectWorkPerChar(() => text.indexOf("b"), text.length, 1)).resolves.toBe(1001);
    await expect(expectWorkPerChar(() => [text.indexOf("b"), text.indexOf("b")], text.length, 1)).rejects.toMatchObject({ name: "AssertionError" });
  });
});

describe("the linear work check", () => {
  /** One search per item: linear when each starts where the last ended, quadratic when each starts over. */
  const scan = (items: number, fromStart: boolean) => {
    const source = "x,".repeat(items);
    return () => {
      for (let at = 0, i = 0; i < items; i++) at = source.indexOf(",", fromStart ? 0 : at) + (fromStart ? 0 : 1) || at + 2;
    };
  };
  const rescan = (items: number) => {
    const source = "x,".repeat(items);
    return () => {
      for (let i = 0; i < items; i++) source.indexOf("y", 2 * i);
    };
  };

  it("passes a scan linear in its input", async () => {
    expect(await expectLinearWork((n) => scan(n, false), 8_000)).toBeLessThan(9);
  });

  it("fails a rescan to the end per item on an assertion, which a call count would miss", async () => {
    await expect(expectLinearWork(rescan, 8_000)).rejects.toMatchObject({ name: "AssertionError" });
  });
});
