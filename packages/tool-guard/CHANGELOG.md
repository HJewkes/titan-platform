# @titan-design/tool-guard

## 0.1.1

### Patch Changes

- 31c57a2: Decode `echo -e` and `printf %b` octal as `\0nnn`, and stop at `\c`, so `echo -e '\0147it push' | sh` is read as `git push`. A printf format string keeps the `$'...'` `\nnn` rule.

## 0.1.0

### Minor Changes

- 06e4078: Add the preference family: `checkPreferences(commands, ctx)` checks commands parsed by `extractCommands` against seven rows (R86 kill by name, R50 local publish, R31 a merge or release chained to other commands, R127 CI polling, R133 a raw merge in a seat session, R64 `XDG_DATA_HOME` before `active-work`, R164 skipped git hooks) and returns `{ id, message }[]`, each message one sentence saying what to do instead. Pure: no filesystem, environment or clock.

### Patch Changes

- b2439b1: Keep `$'` literal inside double quotes in the shell lexer, as bash does. Previously `echo "$'" ; git push origin HEAD:main ; echo "'"` decoded an ANSI-C string across the quotes and hid the push. ANSI-C decoding outside double quotes is unchanged.
- b553557: `xargs -0`, `--null` and `-d` now split appended input on their separators without `-I`, so `printf 'push,origin,HEAD:main' | xargs -d, git` reads as a push to main. A bare `-0` is recorded as a separator, and an unreadable `-d` value adds a reading per input character so it fails closed.

  The value-taking long options `--delimiter`, `--arg-file`, `--max-procs`, `--max-chars` and `--process-slot-var` now consume their separate value, so `xargs --delimiter , git` reads `git` as the command.

  An xargs long option given as an unambiguous prefix, as getopt_long accepts (`--delim=,`, `--nu`, `--max-a 1`), is read as the option it abbreviates. An ambiguous prefix such as `--max` is read both with and without a value, so either reading can block.

## 0.0.1

### Patch Changes

- 4ff5b0a: `xargs -I` now runs its command once per input line, so a push on a later line of piped text, a here-string or a heredoc is classified as a push. A line that is only the replace string is read as shell words.
- 7851c2d: Model `xargs -L N` and `-n N` as one command per batch of lines or arguments, read an unreadable `-d` value as a split on every character, and read a protected `git` or `gh` fed `{}` from unknown stdin as its worst case.
