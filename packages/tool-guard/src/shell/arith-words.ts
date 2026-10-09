const SUBSCRIPT_WRITE_RE = /^[A-Za-z_]\w*\[(.*)\]\+?=/s;
const ELEMENT_READ_RE = /\$\{[!#]?[A-Za-z_]\w*\[/g;
const OFFSET_RE = /\$\{[A-Za-z_]\w*(?:\[[^\]]*\])?:(?![-=+?])([^}]*)\}/g;
const IDENTIFIER_RE = /^[A-Za-z_]\w*$/;
const ASSIGNED_VALUE_RE = /^[A-Za-z_]\w*\+?=(.*)$/s;
const DECLARER_RE = /^(?:declare|typeset|local)$/;

/**
 * The text of a command's words that bash evaluates as arithmetic apart from `(( ))`, `let` and `[[`: a `$[ ]`,
 * an array subscript written or read, a substring offset and length, and the names a `declare -i` makes integers.
 */
export function arithmeticWordTexts(values: string[]): string[] {
  return [...bracketBodies(values.join(" "), "$["), ...values.flatMap(wordSubscripts), ...integerNames(values)];
}

function wordSubscripts(value: string): string[] {
  const written = SUBSCRIPT_WRITE_RE.exec(value)?.[1] ?? [];
  const read = [...value.matchAll(ELEMENT_READ_RE)].flatMap((m) => bracketBodies(value.slice(m.index + m[0].length - 1), "["));
  return [written, ...read, ...[...value.matchAll(OFFSET_RE)].map((m) => m[1] as string)].flat();
}

/** The text between each `open` and its closing bracket. */
function bracketBodies(text: string, open: string): string[] {
  const bodies: string[] = [];
  for (let at = text.indexOf(open); at >= 0; at = text.indexOf(open, at + 1)) {
    bodies.push(text.slice(at + open.length, closing(text, at + open.length - 1, "[", "]")));
  }
  return bodies;
}

/** A `declare -i` evaluates the value a name already holds. */
function integerNames(values: string[]): string[] {
  const at = values.findIndex((v) => DECLARER_RE.test(v));
  const rest = at < 0 ? [] : values.slice(at + 1);
  return rest.some((v) => /^-[a-zA-Z]*i/.test(v)) ? rest.flatMap(integerOperand) : [];
}

/** The name a `declare -i` evaluates, or the value it assigns, which it evaluates as an expression. */
function integerOperand(word: string): string[] {
  const assigned = ASSIGNED_VALUE_RE.exec(word)?.[1];
  return assigned !== undefined ? [assigned] : IDENTIFIER_RE.test(word) ? [word] : [];
}

/** The index of the bracket closing the one at `from`, or the end of the text. */
function closing(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i;
  }
  return text.length;
}
