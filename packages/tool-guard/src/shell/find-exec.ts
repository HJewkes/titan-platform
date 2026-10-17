import type { WordToken } from "./lexer.js";

const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** The command words of each `find -exec`, `-execdir`, `-ok` and `-okdir`, without their terminator. */
export function findExecs(args: WordToken[]): WordToken[][] {
  const out: WordToken[][] = [];
  for (let i = 0, w = args[0]; w !== undefined; w = args[++i]) {
    if (!FIND_EXEC.has(w.value)) continue;
    const end = execEnd(args, i + 1);
    out.push(args.slice(i + 1, end));
    i = end;
  }
  return out;
}

/** Index of the `;` that ends an exec, or of a `+` right after `{}`; the end of `args` when neither comes. */
function execEnd(args: WordToken[], i: number): number {
  for (let j = i, w = args[i]; w !== undefined; w = args[++j]) {
    if (w.value === ";" || (w.value === "+" && j > i && args[j - 1]?.value === "{}")) return j;
  }
  return args.length;
}
