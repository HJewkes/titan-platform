import type { WordToken } from "./lexer.js";
import { arrayElements } from "./declarations.js";
import { assignedPart } from "./vars.js";
import type { AssignedPart } from "./vars.js";
import { substitutedSources } from "./value-subscripts.js";

/** Keywords that start a command's own words but are not part of them: `do X=1`, `then (( X ))`. */
const LEADING_WORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "{", "!", "time"]);
export function afterKeywords(words: WordToken[]): WordToken[] {
  const start = words.findIndex((word) => word.quoted || !LEADING_WORDS.has(word.value));
  return start < 0 ? [] : words.slice(start);
}

const DECLARING = new Set(["export", "declare", "typeset", "local", "readonly"]);

/** The words that write a variable: the assignments before the command word, the operands of a declaration, and the lists of a loop. */
export function writtenBy(words: WordToken[], head: number): AssignedPart[] {
  const declared = head >= 0 && DECLARING.has(words[head]?.value ?? "") ? words.slice(head + 1) : [];
  const own = head < 0 ? words : words.slice(0, head);
  return [...own, ...declared].flatMap(partsOf).concat(loopWrites(words), words.filter(assignsByDefault).map(defaultWrite));
}

/** The write a word makes and, for a compound array, the one each of its elements makes. */
function partsOf(word: WordToken): AssignedPart[] {
  const part = assignedPart(word);
  if (part === null) return [];
  const elements = (arrayElements.get(word) ?? []).map((e) => ({ ...part, text: e.value, dynamic: e.dynamic, append: false, element: true, sources: substitutedSources(e) }));
  return [{ ...part, sources: substitutedSources(word) }, ...elements];
}

/** `for X in list` and `select X in list` store each item of the list in X. */
function loopWrites(words: WordToken[]): AssignedPart[] {
  const [keyword, name, word] = words;
  if ((keyword?.value !== "for" && keyword?.value !== "select") || keyword.quoted || name === undefined || word?.value !== "in") return [];
  return words.slice(3).map((item) => ({ name: name.value, text: item.value, dynamic: item.dynamic, append: false, element: false, sources: substitutedSources(item) }));
}

const DEFAULT_ASSIGN_RE = /\$\{[A-Za-z_]\w*:?=/;

/** `${X:=text}` stores text in X wherever the word sits. */
const assignsByDefault = (word: WordToken): boolean => DEFAULT_ASSIGN_RE.test(word.value);
const defaultWrite = (word: WordToken): AssignedPart => ({ name: "", text: word.value, dynamic: true, append: false, element: false, sources: substitutedSources(word) });
