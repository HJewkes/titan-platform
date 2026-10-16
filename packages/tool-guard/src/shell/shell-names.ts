/** A restricted shell (`rzsh`, `rbash`, `rksh`) or a versioned one (`zsh5`, `bash5.2`, `ksh-93`) runs the base shell's grammar. */
const VARIANT = /^(?:r(?=bash|zsh|ksh))?(sh|bash|zsh|dash|ksh)(?:-?\d+(?:\.\d+)*)?$/;

/** The base shell a variant name runs, else the name unchanged. `rsh` is the remote shell, never a restricted `sh`. */
export function canonicalShell(name: string): string {
  return VARIANT.exec(name)?.[1] ?? name;
}
