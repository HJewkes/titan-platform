import type { RawToken } from "./types.js";

export type CompromiseTags = ReadonlySet<string>;

const COORDINATORS = new Set(["and", "or", "but", "nor", "yet", "plus", "either", "neither", "&"]);
const WH: Record<string, string> = {
  who: "WP",
  whom: "WP",
  whose: "WP$",
  what: "WP",
  which: "WDT",
  where: "WRB",
  when: "WRB",
  why: "WRB",
  how: "WRB",
};
const COPULA: Record<string, string> = {
  is: "VBZ",
  are: "VBP",
  am: "VBP",
  was: "VBD",
  were: "VBD",
  be: "VB",
  been: "VBN",
  being: "VBG",
};
const AUX: Record<string, string> = {
  has: "VBZ",
  does: "VBZ",
  had: "VBD",
  did: "VBD",
  have: "VBP",
  do: "VBP",
};
const CLITIC: Record<string, string> = {
  "n't": "RB",
  "'re": "VBP",
  "'ve": "VBP",
  "'ll": "MD",
  "'d": "MD",
  "'m": "VBP",
};
const BRACKET: Record<string, string> = {
  "(": "-LRB-",
  "[": "-LRB-",
  "{": "-LRB-",
  ")": "-RRB-",
  "]": "-RRB-",
  "}": "-RRB-",
};
const DO_FORMS = new Set(["do", "does", "did"]);

function closedClassTag(word: string, tags: CompromiseTags): string | null {
  if (word === "a" || word === "an") return "DT";
  if (word === "that" && tags.has("Pronoun")) return "DT";
  if (word === "in") return tags.has("Particle") ? "RP" : "IN";
  return null;
}

/** Tags a token that holds no letter or digit, from its text and its neighbours' spacing. */
export function punctTag(tok: RawToken, prev: RawToken | undefined): string {
  const t = tok.text;
  if (BRACKET[t]) return BRACKET[t];
  if (t === "$" || t === "#") return t;
  if (t === "“" || t === "‘") return "``";
  if (t === "”" || t === "’") return "''";
  if (t === '"' || t === "'") return !prev || prev.whitespace !== "" ? "``" : "''";
  if (/^[.?!]+$/.test(t)) return ".";
  if (t === ",") return ",";
  if (t === "-") return tok.whitespace !== "" || (prev && prev.whitespace !== "") ? ":" : "HYPH";
  if (/^([:;—–…]|\.\.\.|--)+$/.test(t)) return ":";
  if (t === "%") return "NN";
  if (t === "&") return "CC";
  return "NFP";
}

/**
 * The Penn tag that governs a verb: the nearest MD or form of "do", reached by stepping back
 * over adverbs and "n't" ("did not really read", "cannot easily read"). Any other tag stops it.
 */
export function governingTag(pennBefore: readonly string[], wordsBefore: readonly string[]): string | null {
  for (let i = pennBefore.length - 1; i >= 0; i--) {
    const penn = pennBefore[i];
    if (penn === "RB") continue;
    if (penn === "MD") return "MD";
    if (penn === "TO") return "TO";
    return DO_FORMS.has(wordsBefore[i]) ? "DO" : penn;
  }
  return null;
}

function verbTag(word: string, tags: CompromiseTags, governing: string | null): string {
  if (COPULA[word]) return COPULA[word];
  if (AUX[word] && tags.has("Auxiliary")) return AUX[word];
  if (tags.has("Modal")) return "MD";
  if (governing === "MD" || governing === "DO") return "VB";
  if (tags.has("Gerund")) return "VBG";
  if (tags.has("Participle") || tags.has("PerfectTense") || tags.has("Passive")) return "VBN";
  if (tags.has("PastTense")) return "VBD";
  if (tags.has("Infinitive") && governing === "TO") return "VB";
  if (tags.has("PresentTense") && /s$/.test(word) && !tags.has("Infinitive")) return "VBZ";
  return tags.has("Imperative") ? "VB" : "VBP";
}

function nounTag(text: string, tags: CompromiseTags): string {
  const proper =
    tags.has("ProperNoun") ||
    ((tags.has("Person") || tags.has("Place") || tags.has("Organization")) && /^[A-Z]/.test(text));
  if (proper) return tags.has("Plural") ? "NNPS" : "NNP";
  return tags.has("Plural") ? "NNS" : "NN";
}

export interface WordContext {
  /** Governing tag from `governingTag`, or null at the start of the sentence. */
  governing: string | null;
  nextWord: string | undefined;
}

/** Tags a token that holds a letter or digit, from the compromise tags of the term it overlaps. */
export function wordTag(text: string, tags: CompromiseTags, ctx: WordContext): string {
  const word = text.toLowerCase();
  if (CLITIC[word]) return CLITIC[word];
  if (word === "'s") return tags.has("Possessive") && !tags.has("Pronoun") ? "POS" : "VBZ";
  const closed = closedClassTag(word, tags);
  if (closed) return closed;
  if (word === "not") return "RB";
  if (word === "to") return "TO";
  if (word === "used" && ctx.nextWord === "to") return "VBD";
  if (WH[word] && tags.has("QuestionWord")) return WH[word];
  if (tags.has("Value") || tags.has("Cardinal") || tags.has("NumericValue")) {
    return tags.has("Ordinal") ? "JJ" : "CD";
  }
  if (tags.has("Pronoun")) return tags.has("Possessive") ? "PRP$" : "PRP";
  if (tags.has("Determiner")) return "DT";
  if (tags.has("Preposition")) return "IN";
  if (tags.has("Conjunction")) return COORDINATORS.has(word) ? "CC" : "IN";
  if (tags.has("Verb") || tags.has("Copula") || tags.has("Modal") || tags.has("Auxiliary")) {
    return verbTag(word, tags, ctx.governing);
  }
  if (tags.has("Comparative")) return "JJR";
  if (tags.has("Superlative")) return "JJS";
  if (tags.has("Adjective")) return "JJ";
  if (tags.has("Adverb")) return "RB";
  if (tags.has("Particle")) return "RP";
  if (tags.has("Expression")) return "UH";
  if (tags.has("Noun") || tags.size === 0 || tags.has("Date") || tags.has("Acronym")) {
    return nounTag(text, tags);
  }
  return /^[A-Z]/.test(text) ? "NNP" : "NN";
}
