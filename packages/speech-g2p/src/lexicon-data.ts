import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** A gold or silver entry: one pronunciation, or a map from tag (always with `DEFAULT`) to pronunciation. */
export type LexiconEntry = string | Record<string, string | null>;
type LexiconDict = Record<string, LexiconEntry>;

export interface LexiconData {
  golds: LexiconDict;
  silvers: LexiconDict;
}

const GOLD_URL = new URL("../data/us_gold.json", import.meta.url);
const SILVER_URL = new URL("../data/us_silver.json", import.meta.url);

/** Port of misaki `Lexicon.grow_dictionary` (en.py:125-135): adds the other capitalisation of each key, never over an existing key. */
export function growDictionary(d: LexiconDict): LexiconDict {
  const grown: LexiconDict = {};
  for (const [key, value] of Object.entries(d)) {
    if ([...key].length < 2) continue;
    const lower = key.toLowerCase();
    const capitalised = capitalise(key);
    if (key === lower) {
      if (key !== capitalised) grown[capitalised] = value;
    } else if (key === capitalise(lower)) {
      grown[lower] = value;
    }
  }
  return { ...grown, ...d };
}

// Python str.capitalize(): first character upper, the rest lower.
function capitalise(s: string): string {
  const [first = "", ...rest] = [...s];
  return first.toUpperCase() + rest.join("").toLowerCase();
}

function isEntry(v: unknown): v is LexiconEntry {
  if (typeof v === "string") return true;
  if (typeof v !== "object" || v === null || !("DEFAULT" in v)) return false;
  return Object.values(v).every((p) => p === null || typeof p === "string");
}

function isDict(v: unknown): v is LexiconDict {
  return typeof v === "object" && v !== null && Object.values(v).every(isEntry);
}

/** Validates parsed lexicon JSON: every value is a pronunciation or a tag map that carries `DEFAULT`. */
export function parseLexiconDict(parsed: unknown): LexiconDict {
  if (!isDict(parsed)) throw new Error("not a misaki lexicon");
  return parsed;
}

function readDict(url: URL): LexiconDict {
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  return parseLexiconDict(parsed);
}

export function loadLexiconData(): LexiconData {
  return {
    golds: growDictionary(readDict(GOLD_URL)),
    silvers: growDictionary(readDict(SILVER_URL)),
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A cache key for the vendored lexicon: changes if either word list changes by a byte. */
export function dataVersion(): string {
  const gold = sha256Hex(readFileSync(GOLD_URL));
  const silver = sha256Hex(readFileSync(SILVER_URL));
  return sha256Hex(Buffer.from(`${gold}\n${silver}`)).slice(0, 16);
}
