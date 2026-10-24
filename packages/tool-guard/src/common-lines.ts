import { countersLines, countersRefused } from "./common-lines.counters.js";
import { exitCodesLines } from "./common-lines.exit-codes.js";
import { installLines } from "./common-lines.install.js";
import { scriptPathsLines } from "./common-lines.script-paths.js";
import { timingLines } from "./common-lines.timing.js";
import { toolchainLines } from "./common-lines.toolchain.js";

type CommonLineFamily =
  | "timing"
  | "counters"
  | "exit codes"
  | "toolchain PATH exports"
  | "install-then-use"
  | "dynamic script paths";

/** A line main allows. `id` is the row id in the 2026-10-17 capped replan. */
export interface CommonLine {
  readonly id: string;
  readonly family: CommonLineFamily;
  readonly line: string;
}

/**
 * Lines main allows that every tool-guard change must keep allowing. A change may not delete or
 * skip a row; a new common-line false deny is added here instead.
 */
export const COMMON_LINES: readonly CommonLine[] = [
  ...timingLines,
  ...countersLines,
  ...exitCodesLines,
  ...toolchainLines,
  ...installLines,
  ...scriptPathsLines,
];

/** A line main allowed that a decided rule now refuses, and the rule's reason. */
export interface RefusedLine extends CommonLine {
  readonly why: string;
}

/**
 * Lines moved off `COMMON_LINES` by a decision to refuse them, not by a change that happened to: each is asserted to
 * be refused, so a later change that allows one again fails here.
 */
export const REFUSED_COMMON_LINES: readonly RefusedLine[] = [...countersRefused];

/** Files the rows run: path (relative to the temp home) to contents. `app` is the working directory. */
export const COMMON_LINE_FIXTURES: Readonly<
  Record<string, { readonly text: string; readonly mode: number }>
> = {
  "app/gradlew": { text: "#!/bin/sh\necho gradle\n", mode: 0o755 },
  "app/build.sh": { text: "#!/usr/bin/env bash\necho build\n", mode: 0o755 },
  "app/.venv/bin/activate": {
    text: 'VIRTUAL_ENV="$PWD/.venv"\nexport VIRTUAL_ENV\nPATH="$VIRTUAL_ENV/bin:$PATH"\nexport PATH\n',
    mode: 0o644,
  },
  ".cargo/env": { text: 'export PATH="$HOME/.cargo/bin:$PATH"\n', mode: 0o644 },
  "app/node_modules/.bin/eslint": {
    text: '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../eslint/bin/eslint.js" "$@"\n',
    mode: 0o755,
  },
};
