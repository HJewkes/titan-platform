import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** A gold or silver entry: one pronunciation, or a map from tag (always with `DEFAULT`) to pronunciation. */
export type LexiconEntry = string | Record<string, string | null>;
export type LexiconDict = Record<string, LexiconEntry>;

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
  return (
    typeof v === "string" ||
    (typeof v === "object" && v !== null && "DEFAULT" in v)
  );
}

function isDict(v: unknown): v is LexiconDict {
  return typeof v === "object" && v !== null && Object.values(v).every(isEntry);
}

function readDict(url: URL): LexiconDict {
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  if (!isDict(parsed))
    throw new Error(`${url.pathname} is not a misaki lexicon`);
  return parsed;
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
