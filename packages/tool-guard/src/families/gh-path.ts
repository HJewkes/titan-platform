import { isCaseUnsure } from "../shell/case-attrs.js";
import type { WordToken } from "../shell/lexer.js";
import { set } from "./options.js";

/**
 * The gh groups whose verb a family reads: `pr` (`ghPrMerge`, the `pr checkout` branch of `switchDir`), `release`
 * and `workflow` (the release family's `gh` rule) and `gist` (egress `gist`). Any other group is a complete path
 * on its own; a family that starts reading a new group's verb must add the group here.
 */
const VERB_GROUPS = set("pr", "release", "workflow", "gist");
/** gh options that take the next word as their value and may sit before the group. */
const VALUE_OPTS = set("-R", "--repo", "--hostname");

/** An unquoted dynamic word word-splits, so it can carry several path words; the test `shell/git.ts` uses. */
const splits = (word: WordToken | undefined) => Boolean(word?.dynamic && (!word.quoted || word.unquotedExpansion));

/** A known value with a blank that an unquoted expansion would split in bash, though not in zsh. */
const splitsKnown = (word: WordToken | undefined) => Boolean(word?.unquotedExpansion && word.typed !== undefined && /\s/.test(word.value));

/** No gh command name holds a blank, so a path word with one is treated like an unknown one. */
const unknown = (word: WordToken) => word.dynamic || isCaseUnsure(word) || /\s/.test(word.value);

function pathComplete(path: WordToken[]): boolean {
  const [group] = path;
  return path.length >= 2 || (group !== undefined && !VERB_GROUPS.has(group.value));
}

/**
 * Whether the words that pick what gh does, the group and for a group in `VERB_GROUPS` its verb, are only known
 * at run time: an unknown word in a path slot, an unknown option word, or an option value that may split.
 */
export function ghPathUnknown(args: WordToken[]): boolean {
  const path: WordToken[] = [];
  let afterDashes = false;
  for (let i = 0; i < args.length && !pathComplete(path); i++) {
    const word = args[i];
    if (word === undefined) break;
    if (afterDashes || !optionShaped(word)) {
      if (unknown(word)) return true;
      path.push(word);
    } else if (word.value === "--" && !unknown(word)) afterDashes = true;
    else {
      const width = optionWidth(word, args[i + 1]);
      if (width === null) return true;
      i += width - 1;
    }
  }
  return false;
}

/** A word gh may read as an option; an unknown word not written with a leading `-` is read as a path word. */
const optionShaped = (word: WordToken) => word.value.length > 1 && word.value.startsWith("-");

/** How many words an option spans, or null when that or what it leaves for the path is unknown. */
function optionWidth(word: WordToken, next: WordToken | undefined): number | null {
  const valueAt = attachedValueAt(word.value);
  if (word.dynamic || isCaseUnsure(word) || splitsKnown(word)) return valueAt !== null && valueAt <= firstDynamic(word) && !splits(word) ? 1 : null;
  if (valueAt !== null) return 1;
  if (!takesNext(word.value)) return 1;
  return splits(next) || splitsKnown(next) ? null : 2;
}

/** Where an option's own value starts inside its word (`--repo=x`, `-Rx`), null when it has none there. */
function attachedValueAt(v: string): number | null {
  if (v.startsWith("--")) {
    const eq = v.indexOf("=");
    return eq > 0 ? eq + 1 : null;
  }
  const letter = [...v.slice(1)].findIndex((c) => VALUE_OPTS.has(`-${c}`));
  return letter >= 0 && letter + 2 < v.length ? letter + 2 : null;
}

function takesNext(v: string): boolean {
  if (v.startsWith("--")) return VALUE_OPTS.has(v);
  return [...v.slice(1)].some((c) => VALUE_OPTS.has(`-${c}`));
}

/** The first index of `value` whose text is only known at run time; 0 when that cannot be placed. */
function firstDynamic(word: WordToken): number {
  if (!word.dynamic) return 0;
  const at = [...word.refs.map((r) => r.start), ...(word.cuts ?? []).map((c) => c.at)];
  return at.length > 0 ? Math.min(...at) : 0;
}
