import { envSplitWords } from "./env-split.js";
import type { WordToken } from "./lexer.js";
import { literalText, literalValue } from "./literal-word.js";
import type { Assignment } from "./vars.js";
import { SHORT_VALUES } from "./wrapper-long.js";

/** What the argv0 reader needs of a word: its text, and its value only where no evaluator rewrites it first. */
interface OptionWord {
  value: string;
  read: string | null;
}

const optionWord = (w: WordToken): OptionWord => ({ value: w.value, read: literalValue(w) });

/** `--argv0` or any prefix of it, which a dynamic command word may leave unspelled. */
const LONG_ARGV0_RE = /^--a(?:r(?:g(?:v(?:0)?)?)?)?$/;
const LONG_ARGV0_EQ_RE = /^--a(?:r(?:g(?:v(?:0)?)?)?)?=/;

/** Short options of `env` and `exec` that take a value, the rest of the cluster or the next word. */
const ARGV0_VALUED: Record<string, string> = { exec: "a", env: `S${SHORT_VALUES.env.map((v) => v.slice(1)).join("")}` };

export function assignedArgv0(assigned: Assignment[]): Array<string | null> {
  return assigned.filter(([name]) => name === "ARGV0").map(([, value]) => (value === null ? null : literalText(value)));
}

/**
 * The values of `exec -a NAME` and `env -a NAME`/`--argv0[=]NAME`, in cluster or attached form. A letter inside another
 * option's value (`env -uabc`) is not an option, so each cluster is read letter by letter and stops at its first valued one.
 */
export function argv0Values(wrapper: string, words: WordToken[]): Array<string | null> {
  return readArgv0(wrapper, words.map(optionWord));
}

function readArgv0(wrapper: string, options: OptionWord[]): Array<string | null> {
  const valued = Object.hasOwn(ARGV0_VALUED, wrapper) ? ARGV0_VALUED[wrapper] : undefined;
  if (valued === undefined) return [];
  const out: Array<string | null> = [];
  for (let k = 0; k < options.length; k++) {
    const o = options[k];
    if (!o || o.value === "--") break;
    if (wrapper === "env" && LONG_ARGV0_RE.test(o.value)) {
      const next = options[++k];
      if (next) out.push(next.read);
    } else if (wrapper === "env" && LONG_ARGV0_EQ_RE.test(o.value)) {
      out.push(o.read === null ? null : o.read.slice(o.read.indexOf("=") + 1));
    } else if (/^-[^-]/.test(o.value)) {
      const read = readArgv0Cluster(o, options[k + 1], valued);
      if (read.value !== undefined) out.push(read.value);
      k += read.consumedNext ? 1 : 0;
    }
  }
  return out;
}

/**
 * `env -S` splits its string into words before it runs them, and its leading option words are env's own, so
 * `env -S '-a sh zsh -c x'` runs zsh under argv0 `sh`. Every word is read as a possible option, so it over-reads past
 * the command. A string env refuses to split names nothing statically.
 */
export function splitStringArgv0(wrapper: string, script: string): Array<string | null> {
  if (wrapper !== "env") return [];
  const words = envSplitWords(script);
  if (words === null) return [null];
  return readArgv0(wrapper, words.map((w) => ({ value: w.value, read: w.dynamic ? null : w.value })));
}

/** One short-option cluster: the `-a` value if the cluster has one, and whether a valued letter took the next word. */
function readArgv0Cluster(o: OptionWord, next: OptionWord | undefined, valued: string): { value?: string | null; consumedNext: boolean } {
  for (let j = 1; j < o.value.length; j++) {
    const letter = o.value.charAt(j);
    if (!valued.includes(letter)) continue;
    const attached = o.value.slice(j + 1);
    const word = attached ? o : next;
    const value = word ? (word.read === null ? null : attached ? word.read.slice(j + 1) : word.read) : undefined;
    return { value: letter === "a" ? value : undefined, consumedNext: !attached };
  }
  return { consumedNext: false };
}
