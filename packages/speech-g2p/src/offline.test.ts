import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { misakiEnglish } from "./misaki-english.js";

// The lexicon load measures ~0.65 s alone; the hook limit leaves room for a loaded machine.
const LOAD_TIMEOUT_MS = 15_000;

const fetch = vi.fn(() => {
  throw new Error("speech-g2p must not fetch");
});
let english: ReturnType<typeof misakiEnglish>;

beforeAll(() => {
  vi.stubGlobal("fetch", fetch);
  english = misakiEnglish();
}, LOAD_TIMEOUT_MS);

afterAll(() => {
  vi.unstubAllGlobals();
});

it("constructs and phonemizes without a network call", () => {
  const { phonemes } = english.phonemize("It cannot read a pull request's files.");

  expect(phonemes).toContain("ɹˈid");
  expect(fetch).not.toHaveBeenCalled();
});
