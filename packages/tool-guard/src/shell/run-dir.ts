import type { WordToken } from "./lexer.js";

/**
 * Options with which a wrapper or package runner starts its command in another directory: `env -C`, `sudo -D`,
 * `pnpm --filter`/`-C`/`-r`, `npm --prefix`/`-w`, `yarn --cwd`, `bun --cwd`. A relative path the command names is then
 * relative to a directory the line does not show.
 */
const CHDIR_OPTIONS: Readonly<Record<string, RegExp>> = {
  env: /^(?:-[A-Za-z0-9]*C|--chdir(?:=|$))/,
  sudo: /^(?:-[A-Za-z]*D|--chdir(?:=|$))/,
  pnpm: /^(?:-[A-Za-z]*[FCrw]|--(?:filter|dir|recursive|workspace-root|filter-prod)(?:=|$))/,
  npm: /^(?:-[A-Za-z]*[Cw]|-ws$|--(?:prefix|workspaces?)(?:=|$))/,
  yarn: /^--cwd(?:=|$)/,
  bun: /^(?:--(?:cwd|filter)(?:=|$)|-[A-Za-z]*F)/,
};

/** Whether `name`'s own options, read before the command it runs, move that command's working directory. */
export function changesDir(name: string, options: readonly WordToken[]): boolean {
  const option = Object.hasOwn(CHDIR_OPTIONS, name) ? CHDIR_OPTIONS[name] : undefined;
  return option !== undefined && options.some((w) => w.dynamic || option.test(w.value));
}
