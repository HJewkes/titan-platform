import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { misakiEnglish } from "./misaki-english.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const readFileSync = vi.fn(actual.readFileSync);
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

// Building the lexicon reads us_silver.json as text; the version hash reads it as bytes, so only text reads count.
const silverTextReads = (): number =>
  vi.mocked(fs.readFileSync).mock.calls.filter(([path, encoding]) => String(path).endsWith("us_silver.json") && encoding === "utf8").length;

// The one dictionary load can take seconds on a loaded CI runner.
const LOAD_TIMEOUT_MS = 20_000;

describe("misakiEnglish lexicon", { timeout: LOAD_TIMEOUT_MS }, () => {
  it("loads the base dictionaries once per process, however many instances and caller words", () => {
    const plain = misakiEnglish();
    const withWords = misakiEnglish({ words: { kokoro: "kˈOkəɹO" } });

    expect(silverTextReads()).toBe(1);
    expect(plain.phonemize("kokoro").phonemes).not.toBe("kˈOkəɹO");
    expect(withWords.phonemize("kokoro").phonemes).toBe("kˈOkəɹO");
  });
});
