import type { WordToken } from "./lexer.js";

/** Long options that take the next word. zsh's `--emulate` must come first, but reading it anywhere only over-reads. */
const LONG_VALUES = new Set(["--rcfile", "--init-file", "--emulate"]);
const CLUSTER_RE = /^[-+][A-Za-z]+$/;

export interface ShellOperands {
  hasC: boolean;
  /** The `-c` string, or else a script file; null when there is none, or `-s` makes stdin the script. */
  positional: WordToken | null;
}

/**
 * Whether a shell's options include `-c`, and its first operand. `-` ends the options as `--` does. Under `-s`
 * without `-c` the operands are positional parameters, so there is no script operand.
 */
export function shellOperands(args: WordToken[], shell: string | null): ShellOperands {
  let hasC = false;
  let hasS = false;
  const operand = (w: WordToken | undefined): ShellOperands => ({ hasC, positional: hasS && !hasC ? null : (w ?? null) });
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value ?? "";
    if (v === "-" || v === "--") return operand(args[i + 1]);
    if (LONG_VALUES.has(v)) i++;
    else if (v.startsWith("--")) continue;
    else if (CLUSTER_RE.test(v)) {
      const { letters, values } = clusterOptions(v, shell === "zsh");
      hasC ||= v.startsWith("-") && letters.includes("c");
      hasS ||= v.startsWith("-") && letters.includes("s");
      i += values;
    } else return operand(args[i]);
  }
  return operand(undefined);
}

/**
 * A cluster's option letters and how many next words they take. bash, dash and ksh give each `o`, and bash each `O`,
 * the next word (`-eo pipefail`, `-oc pipefail TEXT`). zsh's `o` takes the rest of the cluster when any is left
 * (`-oerrexit`), else the next word, and zsh's `O` takes none (`zsh -O -c TEXT` runs TEXT).
 */
function clusterOptions(v: string, zsh: boolean): { letters: string; values: number } {
  const letters = v.slice(1);
  if (!zsh) return { letters, values: [...letters].filter((l) => l === "o" || l === "O").length };
  const o = letters.indexOf("o");
  if (o < 0) return { letters, values: 0 };
  return { letters: letters.slice(0, o), values: o === letters.length - 1 ? 1 : 0 };
}
