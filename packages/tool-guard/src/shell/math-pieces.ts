/**
 * A math text split into the run-time pieces the shell expands before it parses the math. `bare` has each piece
 * replaced by a number, for the bare names math reads; `joined` has each removed, so a store spelled across one
 * (`commands$x=1`) still reads as one. `opaque` marks a piece whose text no rule here can vouch for.
 */
interface MathPieces {
  bare: string;
  joined: string;
  /** Names whose values `$name`, `${name}` and `${name:-w}` expand; digits, `@` and `*` are positional. */
  names: string[];
  /** Math texts inside pieces: a `${name:-w}` default, an element subscript. */
  texts: string[];
  /** The text of each `$( )` and backquote, whose output lands in the math. */
  commands: string[];
  opaque: boolean;
}

const NAME_RE = /^(?:[A-Za-z_]\w*|\d+|[@*])/;
/** `${#name}`, `${#name[@]}`, `$#`'s braced form: a length is digits; a length of one element reads its subscript. */
const LENGTH_RE = /^#(?:[A-Za-z_]\w*|\d+|[@*])?(?:\[(.*)\])?$/s;
/** `${name}`, `${name[i]}`, `${name:-w}` and `${name-w}`; any other operator may yield any text. */
const BRACED_RE = /^([A-Za-z_]\w*|\d+|[@*])(?:\[(.*)\])?(?::?-(.*))?$/s;

/** Reads every run-time piece of a math text in one pass. */
export function readPieces(text: string): MathPieces {
  const out: MathPieces = { bare: "", joined: "", names: [], texts: [], commands: [], opaque: false };
  let i = 0;
  while (i < text.length) {
    const end = piece(text, i, out);
    if (end === i) {
      out.bare += text[i];
      out.joined += text[i];
      i++;
    } else {
      out.bare += " 0 ";
      i = end;
    }
  }
  return out;
}

/** Reads the piece at `at` into `out`; returns where it ends, or `at` when none starts there. */
function piece(text: string, at: number, out: MathPieces): number {
  if (text[at] === "`") return backquote(text, at, out);
  if (text[at] !== "$") return at;
  if (text.startsWith("$((", at)) return at + 3;
  if (text.startsWith("$[", at)) return at + 2;
  if (text.startsWith("$(", at)) return substitution(text, at, out);
  if (text.startsWith("${", at)) return braced(text, at, out);
  return unbraced(text, at, out);
}

function substitution(text: string, at: number, out: MathPieces): number {
  const end = closeAt(text, at + 2, "(", ")");
  if (end < 0) return opaque(text, out);
  out.commands.push(text.slice(at + 2, end));
  return end + 1;
}

/** A backquote whose text holds a backslash is read as opaque, rather than undoing its escapes. */
function backquote(text: string, at: number, out: MathPieces): number {
  const end = text.indexOf("`", at + 1);
  const inner = end < 0 ? "\\" : text.slice(at + 1, end);
  if (inner.includes("\\")) return opaque(text, out);
  out.commands.push(inner);
  return end + 1;
}

function braced(text: string, at: number, out: MathPieces): number {
  const end = closeAt(text, at + 2, "{", "}");
  if (end < 0) return opaque(text, out);
  const inner = text.slice(at + 2, end);
  const length = LENGTH_RE.exec(inner);
  const plain = length ? null : BRACED_RE.exec(inner);
  if (length) {
    if (length[1] !== undefined && length[1] !== "@" && length[1] !== "*") out.texts.push(length[1]);
  } else if (plain) {
    out.names.push(plain[1] ?? "");
    out.texts.push(...[plain[2], plain[3]].filter((t) => t !== undefined));
    // A default is spliced in place of the name, so it joins the text around it: `commands${e:-[y]=0}`.
    out.joined += plain[3] ?? "";
  } else out.opaque = true;
  return end + 1;
}

/** `$#`, `$?`, `$$` and `$!` are numbers, as is zsh's `$+name`; `$name` and `$1` expand a value; any other `$` is opaque. */
function unbraced(text: string, at: number, out: MathPieces): number {
  const next = text[at + 1] ?? "";
  if (next !== "" && "#?$!".includes(next)) return at + 2;
  if (next === "+") return at + 2 + (/^[A-Za-z_]\w*/.exec(text.slice(at + 2))?.[0].length ?? 0);
  const name = /^\d/.test(next) ? next : NAME_RE.exec(text.slice(at + 1))?.[0];
  if (name === undefined) return opaque(text, out);
  out.names.push(name);
  return at + 1 + name.length;
}

function opaque(text: string, out: MathPieces): number {
  out.opaque = true;
  return text.length;
}

/** The index of the bracket that closes the one opened just before `from`, or -1 when none does. */
function closeAt(text: string, from: number, open: string, close: string): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}
