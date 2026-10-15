// Port of misaki 0.9.4 `Lexicon` word lookup (en.py:157-359), Apache-2.0. US English only; numbers live elsewhere.
import type { LexiconData, LexiconEntry } from "./lexicon-data.js";
import { applyStress, PRIMARY_STRESS, SECONDARY_STRESS } from "./stress.js";

/** What the right-to-left pass knows about the next token (misaki `TokenContext`). */
export interface TokenContext {
  /** Whether the next word starts with a vowel sound; `null` when no word follows. */
  futureVowel: boolean | null;
  /** Whether the next word is "to". */
  futureTo: boolean;
}

/** Phonemes and rating (5 override, 4 gold, 3 silver or spelled out), or `null`s when the word is unknown. */
export type Pronunciation = readonly [phonemes: string | null, rating: number | null];

const UNKNOWN: Pronunciation = [null, null];
const ADD_SYMBOLS: Record<string, string> = { ".": "dot", "/": "slash" };
const SYMBOLS: Record<string, string> = { "%": "percent", "&": "and", "+": "plus", "@": "at" };
// misaki LEXICON_ORDS: apostrophe, hyphen and ASCII letters.
const LEXICON_CHARS = /^[A-Za-z'-]+$/;
const US_TAUS = new Set("AIOWYiuæɑəɛɪɹʊʌ");
const DOUBLED_ING = /([bcdgklmnprstvxz])\1ing$|cking$/;
// The casings misaki's special cases match on.
const A = new Set(["a", "A"]);
const AM = new Set(["am", "Am", "AM"]);
const AN = new Set(["an", "An", "AN"]);
const BY = new Set(["by", "By", "BY"]);
const USED = new Set(["used", "Used", "USED"]);
const TO = new Set(["to", "To"]);
const IN = new Set(["in", "In"]);
const THE = new Set(["the", "The"]);

const has = (dict: object, key: string): boolean => Object.hasOwn(dict, key);
// Python str.isalpha(): non-empty and every character a letter.
const isAlpha = (s: string): boolean => /^\p{L}+$/u.test(s);
const isUpper = (s: string): boolean => s === s.toUpperCase();
const length = (s: string): number => [...s].length;

/** misaki `get_parent_tag`: the coarse tag a lexicon dict may be keyed by when the Penn tag itself is absent. */
export function parentTag(tag: string | null): string | null {
  if (tag === null) return null;
  if (tag.startsWith("VB")) return "VERB";
  if (tag.startsWith("NN")) return "NOUN";
  if (tag.startsWith("ADV") || tag.startsWith("RB")) return "ADV";
  if (tag.startsWith("ADJ") || tag.startsWith("JJ")) return "ADJ";
  return tag;
}

function pickByTag(
  entry: Record<string, string | null>,
  tag: string | null,
  ctx: TokenContext | null
): string | null {
  let key = tag;
  if (ctx !== null && ctx.futureVowel === null && has(entry, "None")) key = "None";
  else if (key === null || !has(entry, key)) key = parentTag(tag);
  return key !== null && has(entry, key) ? (entry[key] ?? null) : (entry["DEFAULT"] ?? null);
}

function suffixS(stem: string | null): string | null {
  if (!stem) return null;
  if ("ptkfθ".includes(stem.at(-1)!)) return stem + "s";
  if ("szʃʒʧʤ".includes(stem.at(-1)!)) return stem + "ᵻz";
  return stem + "z";
}

function suffixEd(stem: string | null): string | null {
  if (!stem) return null;
  const last = stem.at(-1)!;
  if ("pkfθʃsʧ".includes(last)) return stem + "t";
  if (last === "d") return stem + "ᵻd";
  if (last !== "t") return stem + "d";
  if (stem.length < 2) return stem + "ɪd";
  if (US_TAUS.has(stem.at(-2)!)) return stem.slice(0, -1) + "ɾᵻd";
  return stem + "ᵻd";
}

function suffixIng(stem: string | null): string | null {
  if (!stem) return null;
  if (stem.length > 1 && stem.at(-1) === "t" && US_TAUS.has(stem.at(-2)!)) {
    return stem.slice(0, -1) + "ɾɪŋ";
  }
  return stem + "ɪŋ";
}

/** misaki's US `Lexicon` over gold and silver dicts already grown by `growDictionary`. */
export class Lexicon {
  private readonly golds: LexiconData["golds"];
  private readonly silvers: LexiconData["silvers"];

  constructor(data: LexiconData) {
    this.golds = data.golds;
    this.silvers = data.silvers;
  }

  private gold(word: string): LexiconEntry | undefined {
    return has(this.golds, word) ? this.golds[word] : undefined;
  }

  private silver(word: string): LexiconEntry | undefined {
    return has(this.silvers, word) ? this.silvers[word] : undefined;
  }

  private goldString(word: string, tag = "DEFAULT"): string | null {
    const entry = this.gold(word);
    if (typeof entry === "string") return entry;
    return entry?.[tag] ?? null;
  }

  /** misaki `get_NNP`: spells the word letter by letter, primary stress on the last letter. */
  getNNP(word: string): Pronunciation {
    const letters = [...word].filter(isAlpha).map((c) => this.gold(c.toUpperCase()));
    if (letters.some((ps) => typeof ps !== "string")) return UNKNOWN;
    const ps = applyStress(letters.join(""), 0) ?? "";
    const last = ps.lastIndexOf(SECONDARY_STRESS);
    const spelled = last < 0 ? ps : ps.slice(0, last) + PRIMARY_STRESS + ps.slice(last + 1);
    return [spelled, 3];
  }

  isKnown(word: string): boolean {
    if (this.gold(word) !== undefined || has(SYMBOLS, word) || this.silver(word) !== undefined) return true;
    if (!isAlpha(word) || !LEXICON_CHARS.test(word)) return false;
    if (length(word) === 1) return true;
    if (isUpper(word) && this.gold(word.toLowerCase()) !== undefined) return true;
    return isUpper(word.slice(1));
  }

  lookup(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): Pronunciation {
    let isNNP = false;
    if (isUpper(word) && this.gold(word) === undefined) {
      word = word.toLowerCase();
      isNNP = tag === "NNP";
    }
    let entry = this.gold(word);
    let rating = 4;
    if (entry === undefined && !isNNP) {
      entry = this.silver(word);
      rating = 3;
    }
    const ps = typeof entry === "object" ? pickByTag(entry, tag, ctx) : (entry ?? null);
    if (ps === null || (isNNP && !ps.includes(PRIMARY_STRESS))) {
      const spelled = this.getNNP(word);
      if (spelled[0] !== null) return spelled;
    }
    return [applyStress(ps, stress), rating];
  }

  private symbolCase(word: string, tag: string, ctx: TokenContext): Pronunciation | null {
    if (tag === "ADD" && has(ADD_SYMBOLS, word)) return this.lookup(ADD_SYMBOLS[word]!, null, -0.5, ctx);
    if (has(SYMBOLS, word)) return this.lookup(SYMBOLS[word]!, null, null, ctx);
    const parts = word.split(".");
    const isAbbreviation =
      word.replace(/^\.+|\.+$/g, "").includes(".") &&
      isAlpha(word.replaceAll(".", "")) &&
      Math.max(...parts.map(length)) < 3;
    return isAbbreviation ? this.getNNP(word) : null;
  }

  private articleCase(word: string, tag: string, stress: number | null, ctx: TokenContext): Pronunciation | null {
    if (A.has(word)) return [tag === "DT" ? "ɐ" : "ˈA", 4];
    if (AM.has(word)) {
      if (tag.startsWith("NN")) return this.getNNP(word);
      if (ctx.futureVowel === null || word !== "am" || (stress !== null && stress > 0)) {
        return [this.goldString("am"), 4];
      }
      return ["ɐm", 4];
    }
    if (AN.has(word)) {
      return word === "AN" && tag.startsWith("NN") ? this.getNNP(word) : ["ɐn", 4];
    }
    if (word === "I" && tag === "PRP") return [`${SECONDARY_STRESS}I`, 4];
    return null;
  }

  // to, in and the: an all-caps form counts only under the tags misaki allows for it.
  private nextWordCase(word: string, tag: string, ctx: TokenContext): Pronunciation | null {
    if (TO.has(word) || (word === "TO" && (tag === "TO" || tag === "IN"))) {
      const to = ctx.futureVowel === null ? this.goldString("to") : ctx.futureVowel ? "tʊ" : "tə";
      return [to, 4];
    }
    if (IN.has(word) || (word === "IN" && tag !== "NNP")) {
      return [(ctx.futureVowel === null || tag !== "IN" ? PRIMARY_STRESS : "") + "ɪn", 4];
    }
    if (THE.has(word) || (word === "THE" && tag === "DT")) {
      return [ctx.futureVowel === true ? "ði" : "ðə", 4];
    }
    return null;
  }

  private taggedWordCase(word: string, tag: string, ctx: TokenContext): Pronunciation | null {
    if (BY.has(word) && parentTag(tag) === "ADV") return ["bˈI", 4];
    if (tag === "IN" && /^vs\.?$/i.test(word)) return this.lookup("versus", null, null, ctx);
    if (USED.has(word)) {
      const beforeTo = (tag === "VBD" || tag === "JJ") && ctx.futureTo;
      return [this.goldString("used", beforeTo ? "VBD" : "DEFAULT"), 4];
    }
    return null;
  }

  /** misaki `get_special_case`: symbols, dotted abbreviations and function words whose reading depends on context. */
  getSpecialCase(word: string, tag: string, stress: number | null, ctx: TokenContext): Pronunciation {
    return (
      this.symbolCase(word, tag, ctx) ??
      this.articleCase(word, tag, stress, ctx) ??
      this.nextWordCase(word, tag, ctx) ??
      this.taggedWordCase(word, tag, ctx) ??
      UNKNOWN
    );
  }

  stemS(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): Pronunciation {
    if (length(word) < 3 || !word.endsWith("s")) return UNKNOWN;
    let stem: string;
    if (!word.endsWith("ss") && this.isKnown(word.slice(0, -1))) stem = word.slice(0, -1);
    else if (
      (word.endsWith("'s") || (length(word) > 4 && word.endsWith("es") && !word.endsWith("ies"))) &&
      this.isKnown(word.slice(0, -2))
    ) {
      stem = word.slice(0, -2);
    } else if (length(word) > 4 && word.endsWith("ies") && this.isKnown(word.slice(0, -3) + "y")) {
      stem = word.slice(0, -3) + "y";
    } else return UNKNOWN;
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [suffixS(ps), rating];
  }

  stemEd(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): Pronunciation {
    if (length(word) < 4 || !word.endsWith("d")) return UNKNOWN;
    let stem: string;
    if (!word.endsWith("dd") && this.isKnown(word.slice(0, -1))) stem = word.slice(0, -1);
    else if (
      length(word) > 4 &&
      word.endsWith("ed") &&
      !word.endsWith("eed") &&
      this.isKnown(word.slice(0, -2))
    ) {
      stem = word.slice(0, -2);
    } else return UNKNOWN;
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [suffixEd(ps), rating];
  }

  stemIng(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): Pronunciation {
    if (length(word) < 5 || !word.endsWith("ing")) return UNKNOWN;
    const base = word.slice(0, -3);
    let stem: string;
    if (length(word) > 5 && this.isKnown(base)) stem = base;
    else if (this.isKnown(base + "e")) stem = base + "e";
    else if (length(word) > 5 && DOUBLED_ING.test(word) && this.isKnown(word.slice(0, -4))) {
      stem = word.slice(0, -4);
    } else return UNKNOWN;
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [suffixIng(ps), rating];
  }

  // A capitalised or all-caps word missing from both dicts is read as its lowercase form when that is known.
  private readsLowercase(word: string, tag: string, stress: number | null, ctx: TokenContext): boolean {
    const lower = word.toLowerCase();
    if (length(word) <= 1 || !isAlpha(word.replaceAll("'", "")) || word === lower) return false;
    if (tag === "NNP" && length(word) <= 7) return false;
    if (this.gold(word) !== undefined || this.silver(word) !== undefined) return false;
    if (!isUpper(word) && word.slice(1) !== word.slice(1).toLowerCase()) return false;
    if (this.gold(lower) !== undefined || this.silver(lower) !== undefined) return true;
    return [this.stemS, this.stemEd, this.stemIng].some((stem) => !!stem.call(this, lower, tag, stress, ctx)[0]);
  }

  private knownVariant(word: string): string | null {
    if (this.isKnown(word)) return word;
    if (word.endsWith("s'") && this.isKnown(word.slice(0, -2) + "'s")) return word.slice(0, -2) + "'s";
    if (word.endsWith("'") && this.isKnown(word.slice(0, -1))) return word.slice(0, -1);
    return null;
  }

  /** misaki `get_word`: special cases, then the lexicon, then -s, -ed and -ing stems; `null`s when nothing reads it. */
  getWord(word: string, tag: string, stress: number | null, ctx: TokenContext): Pronunciation {
    const special = this.getSpecialCase(word, tag, stress, ctx);
    if (special[0] !== null) return special;
    if (this.readsLowercase(word, tag, stress, ctx)) word = word.toLowerCase();
    const known = this.knownVariant(word);
    if (known !== null) return this.lookup(known, tag, stress, ctx);
    for (const [stem, level] of [
      [this.stemS, stress],
      [this.stemEd, stress],
      [this.stemIng, stress ?? 0.5],
    ] as const) {
      const result = stem.call(this, word, tag, level, ctx);
      if (result[0] !== null) return result;
    }
    return UNKNOWN;
  }
}
