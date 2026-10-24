import type { SimpleCommand } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";
import { basename } from "../shell/path.js";

/** Tests that take a name or path pattern; a path pattern is matched by its last segment. */
const NAME_TESTS = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename"]);
const RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** Where find's starting points end and its expression begins. */
const EXPRESSION_START_RE = /^[-(!]/;

/**
 * What `find <dir> -name <name> -delete` (or `-exec`) reaches, as paths to match: `<dir>/**\/<name>` for each starting
 * point and name, or each starting point whole when no name narrows it. None when find only lists, or runs a program
 * `readOnly` names on what it finds.
 */
export function findReaches(cmd: SimpleCommand, readOnly: ReadonlySet<string>): WordToken[] {
  const first = cmd.args[0];
  if (cmd.name !== "find" || first === undefined || !changesFound(cmd.args, readOnly)) return [];
  const end = cmd.args.findIndex((a) => EXPRESSION_START_RE.test(a.value));
  const starts = cmd.args.slice(0, end < 0 ? cmd.args.length : end);
  const roots = starts.length > 0 ? starts : [{ ...first, value: "." }];
  const names = cmd.args.flatMap((a, i) => {
    const name = cmd.args[i + 1];
    return NAME_TESTS.has(a.value) && name !== undefined ? [name] : [];
  });
  if (names.length === 0) return roots;
  // A starting point only known at run time may be any directory, so its names are matched under the root.
  const under = (root: WordToken) => (root.dynamic ? "" : root.value.replace(/\/+$/, ""));
  return roots.flatMap((root) => names.map((name) => ({ ...name, value: `${under(root)}/**/${basename(name.value)}` })));
}

function changesFound(args: readonly WordToken[], readOnly: ReadonlySet<string>): boolean {
  return args.some((a, i) => a.value === "-delete" || (RUNS.has(a.value) && !readOnly.has(args[i + 1]?.value ?? "")));
}
