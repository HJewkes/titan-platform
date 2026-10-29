import { describe, expect, it, vi } from "vitest";
import { misakiEnglish } from "./misaki-english.js";

const lexiconLoads = vi.hoisted(() => ({ calls: 0 }));

vi.mock("./lexicon-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lexicon-data.js")>();
  return {
    ...actual,
    loadLexiconData: () => {
      lexiconLoads.calls += 1;
      return actual.loadLexiconData();
    },
  };
});

// The one dictionary load can take seconds on a loaded CI runner.
const LOAD_TIMEOUT_MS = 20_000;

describe("misakiEnglish lexicon", { timeout: LOAD_TIMEOUT_MS }, () => {
  it("grows the base dictionaries once per process, however many instances and caller words", () => {
    const plain = misakiEnglish();
    const withWords = misakiEnglish({ words: { kokoro: "kˈOkəɹO" } });

    expect(lexiconLoads.calls).toBe(1);
    expect(plain.phonemize("kokoro").phonemes).not.toBe("kˈOkəɹO");
    expect(withWords.phonemize("kokoro").phonemes).toBe("kˈOkəɹO");
  });
});
