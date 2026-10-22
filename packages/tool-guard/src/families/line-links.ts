import type { SimpleCommand } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";
import { expandHome, toAbsolute } from "../paths.js";
import { basename, resolveValue } from "../shell/path.js";
import { argDir } from "../shell/run-dir.js";
import type { ClassifyContext } from "../types.js";
import { copyDestination } from "./copy-destination.js";

/** One symbolic link a command makes: the path of the link and the absolute path it points at. */
interface Link {
  link: string;
  target: string;
}

/**
 * Whether ln makes a symbolic link, read by position: only from the options before its first operand and before `--`,
 * as BSD ln reads them, skipping the values of `-S` and `-t`. After that, `-s` is a file name (`ln -- doc -s` hard-links
 * `doc` to `./-s`). A GNU `-s` after an operand, or one only known at run time, reads as a hard link, which only adds a deny.
 */
export function lnSymbolic(args: readonly WordToken[]): boolean {
  for (let i = 0, word = args[0]; word !== undefined; word = args[++i]) {
    const { value, dynamic } = word;
    if (dynamic || value === "--" || value === "-" || !value.startsWith("-")) return false;
    if (value.startsWith("--")) {
      const name = value.split("=", 1)[0] ?? value;
      if (name.length >= 4 && "--symbolic".startsWith(name)) return true;
      const valued = (name.length >= 4 && "--suffix".startsWith(name)) || (name.length >= 3 && "--target-directory".startsWith(name));
      if (valued && !value.includes("=")) i++;
      continue;
    }
    const valueAt = value.search(/[St]/);
    const flags = valueAt < 0 ? value : value.slice(0, valueAt);
    if (flags.includes("s")) return true;
    if (valueAt === value.length - 1) i++;
  }
  return false;
}

/**
 * The links `ln -s` makes, each at the destination and, should that be a directory, at the source's name inside it.
 * Null when one is only placed at run time. A relative source is resolved from the link's own directory, as the
 * filesystem resolves it.
 */
export function symlinksMade(cmd: SimpleCommand, home: string): Link[] | null {
  const dest = copyDestination(cmd);
  const sources = cmd.args.filter((a) => a !== dest && !a.value.startsWith("-"));
  const dir = argDir(cmd);
  const into = dest === null ? dir : dest.dynamic ? null : resolveValue(dir, expandHome(dest.value, home), home);
  if (into === null || sources.some((s) => s.dynamic)) return null;
  return sources.flatMap((source) => {
    const at = dest === null ? [`${into}/${basename(source.value)}`] : [into, `${into}/${basename(source.value)}`];
    return at.flatMap((link) => toAbsolute(source.value, parentOf(link), home).map((target) => ({ link, target })));
  });
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

/**
 * The line after `ln -s` ran: a path through one of its links resolves to where the link points, which the host's
 * `readLink` cannot see because the link did not exist when the hook ran. A guarded `&&` chain's fallback learns it too.
 */
export function withLinks(ctx: ClassifyContext, links: readonly Link[]): ClassifyContext {
  const readLink = (path: string): string | null => {
    const through = links.find(({ link }) => path === link || path.startsWith(`${link}/`));
    if (through === undefined) return ctx.readLink(path);
    const real = through.target + path.slice(through.link.length);
    return safeReadLink(ctx, real) ?? real;
  };
  const trust = ctx.chainTrust;
  return { ...ctx, readLink, ...(trust ? { chainTrust: { ...trust, fallback: withLinks(trust.fallback, links) } } : {}) };
}

function safeReadLink(ctx: ClassifyContext, path: string): string | null {
  try {
    return ctx.readLink(path);
  } catch {
    return null;
  }
}
