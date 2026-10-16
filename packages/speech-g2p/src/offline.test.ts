import { afterEach, expect, it, vi } from "vitest";
import { misakiEnglish } from "./misaki-english.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("constructs and phonemizes without a network call", () => {
  const fetch = vi.fn(() => {
    throw new Error("speech-g2p must not fetch");
  });
  vi.stubGlobal("fetch", fetch);

  const { phonemes } = misakiEnglish().phonemize("It cannot read a pull request's files.");

  expect(phonemes).toContain("ɹˈid");
  expect(fetch).not.toHaveBeenCalled();
});
