import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dataVersion,
  growDictionary,
  loadLexiconData,
  sha256Hex,
} from "./lexicon-data.js";

// From the misaki 0.9.4 wheel's RECORD (base64 sha256 there, hex here).
const WHEEL_FILES: [name: string, sha256: string, bytes: number][] = [
  [
    "us_gold.json",
    "dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f",
    3000469,
  ],
  [
    "us_silver.json",
    "de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475",
    3099517,
  ],
];

describe("vendored lexicon", () => {
  it.each(WHEEL_FILES)(
    "%s matches the misaki 0.9.4 wheel hash and size",
    (name, sha256, size) => {
      const bytes = readFileSync(new URL(`../data/${name}`, import.meta.url));

      expect(sha256Hex(bytes)).toBe(sha256);
      expect(bytes.length).toBe(size);
    }
  );

  it("loads gold with tag dicts that always carry DEFAULT", () => {
    const { golds } = loadLexiconData();
    const live = golds["live"];

    expect(typeof live).toBe("object");
    expect(live).toHaveProperty("DEFAULT");
  });

  it("derives a stable data version", () => {
    expect(dataVersion()).toMatch(/^[0-9a-f]{16}$/);
    expect(dataVersion()).toBe(dataVersion());
  });
});

describe("growDictionary", () => {
  it("adds the capitalised form of a lowercase key and the lowercase of a capitalised one, skipping one-letter keys", () => {
    const grown = growDictionary({
      cat: "kˈæt",
      Paris: "pˈæɹɪs",
      a: "ɐ",
      A: "ˈA",
    });

    expect(grown["Cat"]).toBe("kˈæt");
    expect(grown["paris"]).toBe("pˈæɹɪs");
    expect(grown["a"]).toBe("ɐ");
    expect(Object.keys(grown).sort()).toEqual([
      "A",
      "Cat",
      "Paris",
      "a",
      "cat",
      "paris",
    ]);
  });

  it("never overwrites an existing key with a grown one", () => {
    const grown = growDictionary({ cat: "kˈæt", Cat: "other" });

    expect(grown["Cat"]).toBe("other");
  });

  it("leaves an all-caps key without a lowercase twin", () => {
    expect(growDictionary({ NASA: "nˈæsə" })).toEqual({ NASA: "nˈæsə" });
  });
});
