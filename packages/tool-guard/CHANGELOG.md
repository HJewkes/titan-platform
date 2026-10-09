# @titan-design/tool-guard

## 0.3.0

### Minor Changes

- 661d2dc: The package is now public on npm, so the owner can pin it for the authority-guard PreToolUse hook. No code changed.

### Patch Changes

- c6a5bc5: Read a command word lower-cased too where the filesystem finds a program whatever its case (darwin, Windows), so `GIT push origin HEAD:main`, `/USR/BIN/GIT push`, `GH pr merge 5` and `NPM publish` classify as the lower-case spelling. The whole line is read a second time with every command word folded, so pipes, groups, branch switches and nested shells see the folded name. That reading only adds actions to the as-written one. The fold upper-cases then lower-cases, so the long s and ligatures APFS folds (`baſh`, `ſudo`, `ﬆdbuf`) read as `bash`, `sudo` and `stdbuf`. Builtins such as `cd` and `export` stay as written, because bash matches them exactly. `nodeContext` turns it on by platform through the new `ClassifyContext.foldCase`; Linux keeps reading the word as written.
- 17adaec: Read xargs with no piped input and a dynamic word behind a wrapper as the push they may be. An unknown `-I` record fills every place its replace string appears with the worst case, so `xargs -I % git push origin %` reads as a protected push. A dynamic word that a wrapper reads as its positional or as the command word may expand to nothing, an option or another wrapper. The words are therefore also read without it, wrapper by wrapper, with the piped input still known: `timeout $O 5 git push` and `printf 'HEAD:main\n' | sudo $a xargs -I % git push origin %` now give a push verdict. Every such reading that runs a guarded program, a shell, `eval`, `find`, xargs or a dynamic command word is walked, since dropping a word is not monotone: `timeout $P git push` pushes only when `$P` is the duration. Readings that run anything else are skipped for free. A line whose walked readings would pass 512 words is refused as too large to check, like a command over 8 KiB, instead of being read in part. A script the line runs is not refused for that: past 512 words it reads its remaining commands as main does, without the readings, so a lone `./install.sh` of many `$SUDO cp` lines passes as on main; a script every reading runs is walked once. A shell script run by path is classified once per line state, so `timeout $P . a.sh` and its case-folded reading, or `. a.sh; bash a.sh`, read a 64 KiB script once instead of once per reading.

  A line may classify at most 64 KiB of script text across all its readings. A shell script the line runs as written counts its size. A shell or interpreter script (python3, node, ruby, perl and the rest) that only an added reading runs counts four times its size, because main never reads it, so such a script is read up to 16 KiB. An interpreter script the line runs as written is not counted, as before. A script read again from the cache costs nothing. A line past the budget is refused as too large to check. The deny names the limit, the size reached and the script, and gives a split that then passes: write the wrapper out (`sudo ./x.sh`, not `$SUDO ./x.sh`) for a script over 16 KiB behind a variable, or run the named script in its own command. A lone script under 16 KiB behind a variable, such as `$SUDO ./install.sh`, is read and passes as on main.

  Guarded path patterns are compiled once per process instead of once per path tested, so script and argument text naming many paths classifies about eight times faster.

- Updated dependencies [2ff0840]
- Updated dependencies [69db518]
- Updated dependencies [c517313]
- Updated dependencies [dcde08d]
- Updated dependencies [20778a2]
  - @titan-design/authority@0.4.0

## 0.2.1

### Patch Changes

- e84b324: Read BSD `xargs -J replstr` as an insert string: each run's input items are spliced in at the argument equal to it, so a push or merge target piped through `-J` is classified, and unreadable stdin fails closed as it does for `-I`. A separate `-I` or `-J` value that looks like an option (`-J -i`) is read as the value, and input quotes and backslashes are also read as xargs drops them when it splits on blanks. These added readings walk a copy of the variables, are dropped when the script they build cannot parse or when classifying them throws, never move the line's tracked state, and past 256 runs they fail closed to the worst case, so a long input cannot hold the hook past its timeout.
- 426ac3c: The xargs option readers no longer read a word an option takes as its value as an option of its
  own: `xargs --max-args -0 git push origin` is not read as NUL-separated input, and `-E -n2` is not
  a batch size. The reading the guard had before is kept beside the new one, so no verdict loosens.
- aab5e8e: A command word with an odd bracket, such as `[]*+]`, no longer makes the glob compiler throw and the hook allow the whole line; bracket classes follow bash rules, and an uncompilable pattern fails closed (TP-1780).

## 0.2.0

### Minor Changes

- daf1326: Add `decide`, `observeActor`, the deny log format, `handle` and the `titan-tool-guard` bin with `hook`, `print-settings` and `report`. The hook denies a classified merge, release, credential read, permission-config edit or private egress through the PreToolUse deny answer, never throws and always exits 0. `print-settings` prints the settings entry and writes nothing.

### Patch Changes

- 52a368e: Fail closed on a git command whose subcommand word is dynamic. `git $Y origin HEAD:main` with `Y` unknown now classifies as `bash.merge.git-push-protected` with branch `unknown` (and an unknown egress destination) instead of no guarded action. `git "$Y" status` is an accepted false positive.
- 77c59bc: Track arithmetic writes made through a variable's value or a `$(( ))` expansion, so a name written there no longer keeps a stale exact value.
- 1742cfb: Track the `-l` and `-u` case attributes of `declare`, `typeset` and `local`. A value such an attribute may change is still read as written, which is what bash 3.2 runs, and the word it expands into is marked. A marked git subcommand or push destination classifies as `bash.merge.git-push-protected` with branch `unknown`, so `declare -l Y; Y=PUSH; git $Y origin HEAD:main` and `declare -u B; B=main; git push origin HEAD:$B` are protected. The secret family checks a marked argument as written and in both cases. The mark survives copies into other variables and word copies such as `xargs -I`.
- cc9db43: Keep the `declare -l`/`-u` case mark through text `eval` and `sh -c` run, reading it as written, all lower and all upper case, and fold a marked command word the same way, so `declare -l G; G=GIT; $G push origin HEAD:main` reads as a git push.
- 253df65: Share one copy-destination rule between the secret and config families, so `cp -t` and `--target-directory=` no longer hide a copied credential directory.
- 31c57a2: Decode `echo -e` and `printf %b` octal as `\0nnn`, and stop at `\c`, so `echo -e '\0147it push' | sh` is read as `git push`. A printf format string keeps the `$'...'` `\nnn` rule.
- b81840f: Drop NUL bytes from `echo` and `printf` text piped to a shell, as bash and sh do, so `printf 'git pu\0sh origin HEAD:main\n' | bash` is read as `git push`.
- b9b31a9: The variable tracker now honours readonly variables. A variable made readonly by `readonly`, or by `declare`, `typeset` or `local` with an `r` option, keeps its value when a later plain or element assignment, `read`, `printf -v`, `mapfile`, `unset`, `for` or declaration tries to write it, as bash does. A readonly array assignment (`declare -ra`, `readonly -a`) leaves the value unknown, because bash 3.2 rejects it and bash 5 does not. A readonly makes a variable surely readonly only when it surely runs once in the current shell. A readonly after `&&` or `||`, in an `if`, loop or `case` body, in a function body, in a pipeline, background job or `coproc`, under a wrapper that runs a program (`env`, `sudo`, `xargs`), or from `local` makes it only possibly readonly. A variable that only may be readonly becomes unknown on a write, including after a function returns from a `local -r`, inside `eval` or a child shell, or after a declaration word known only at run time.
- 17fd927: Read every short wrapper option that takes a separate value, so its value is no longer read as the command: sudo `-a`, `-c`, `-R` and `-T`, env `-a`, BSD env `-P` and FreeBSD env `-L` and `-U`, BSD xargs `-J`, `-R` and `-S`, and GNU time `-f` and `-o` (with `--format`, `--output` and their abbreviations). `sudo -R / git push origin HEAD:main` now classifies as the push it runs.
- fedd2d9: The shell lexer keeps a subscript assignment with blanks inside the brackets as one word, as bash does: `Y[ 0 ]=x git push origin HEAD:main` now yields the git push, and `Y[ 0 ]=push` before `git $Y` counts as a write to `Y`. This applies only where an assignment may stand and only when `=` or `+=` follows the `]`. `[ 0 ]`, `echo Y[ 0 ]`, an unclosed bracket, and a bracket with no `=` after it lex as before.
- b0718aa: Variable tracking now sees subscripted writes. `Y[0]=push` and `declare 'Y[0]=push'` (also `typeset` and `local`) set `$Y` to the element-0 value. `export` and `readonly` reject a subscripted name, so they leave the variable unchanged. An element declared with `-r` makes the variable unknown. A word known only at run time passed to `export`, `declare`, `typeset`, `local` or `readonly` can be any assignment, so it makes every tracked variable unknown, `HOME` included. So does any option letter except those that assign the value as written in bash 3.2 and 5 alike (`a i r t x` for `declare`, `typeset` and `local`, `n` for `export`, `a` for `readonly`), such as `declare -f`, `declare -l`, `declare -Q` or the glob `-[r]`. Any other subscripted write, `mapfile` and `readarray` make the variable unknown. An element assignment before a command is skipped as an assignment, so `Y[0]=x git push` is read as the git command.
- 80043c2: Variable tracking now sees the writes `select`, `getopts`, `let` and `(( ))` make. `select NAME` and `getopts ... NAME` leave NAME unknown, and `getopts` also leaves `OPTARG` and `OPTIND` unknown. `let` and `(( ))` leave each name they assign unknown, even one assigning a literal integer, since the walk cannot tell whether the `let` surely runs in this shell. A run-time expression may write any variable, so all tracked values become unknown. A surely readonly variable keeps its old value, as with a plain assignment. Before this change, `Y=status; select Y in push; do git $Y ...; done` still read as `git status`.
- f016890: Track `NAME+=value` appends (plain and through `declare`/`typeset`/`local`/`export`) and `printf -vNAME`, so `Y=pu; Y+=sh; git $Y origin HEAD:main` and `X=status; printf -vX push; git $X origin HEAD:main` classify as pushes to main. An append is literal only when both parts are; otherwise the variable is unknown.

  `printf -v` is read only as the first argument, so `printf -- -vX` and `printf '%s\n' -vX` leave X alone. An array assignment (`Y=(pu sh)`) sets `$Y` to its element 0 when that is plainly literal, and makes it unknown when a brace, glob or `[i]=` element could change it; an array append (`Y+=(sh)`) keeps a known `$Y` and leaves an unset one unknown.

  Inside a function body, `local`, `declare` and `typeset` (without `-g`) make a new local, so `NAME+=value` there starts from empty, as bash does: `Y=status; f() { local Y+=push; git $Y origin HEAD:main; }; f` classifies as a push to main. A `{ }` function body's locals take back their outer value at the closing brace, so `Y=push; f() { local Y=status; }; f; git $Y origin HEAD:main` is a push to main (TP-1473). The outer value is saved in a slot whose name is no shell identifier, so user code cannot overwrite it; `printf -v`, `read`, `unset` and `for` write only shell identifiers, as bash does, and a local inside a nested `( )` subshell is left to that subshell. A case pattern's parentheses no longer end a `( )` function body, and `esac` ends the case at a command's start or in pattern position, so a pipe after an empty case is still a pipe and `echo esac` in a case body does not end the case. A push inside a `function f { ...; }` body is no longer read as arguments of `function`.

- 9145a26: Variable tracking now treats a subscripted `read` or `printf -v` target (`read 'Y[0]'`) as writing the base variable, leaving it unknown, and no longer ends a `case` at an `esac` that is a parenthesised pattern (`(a|esac)`).
- bd4c744: Expand getopt_long abbreviations for the options of timeout, nice, env, stdbuf, nohup, sudo, flock and watch, not only xargs, so `timeout --sig KILL 5 git push origin HEAD:main` no longer reads its value word as the command. An ambiguous prefix is read both ways.
- 397a5e6: Stop exporting the `EscapeMode` type from the shell escape decoder; nothing outside its file imports it.
- 9a9df1a: A command whose words come from stdin through `xargs` is now classified as a direct call is when `xargs` runs a wrapper such as `env`, `sudo`, `nohup`, `nice` or `timeout`: `echo gh pr merge 1 | xargs env` and `printf 'git\0push origin HEAD:main' | xargs -0 sudo` no longer slip past rules their direct forms hit.
- 097b1a1: An `xargs` run whose command word is dynamic (`xargs "$G" push origin HEAD:main`) now fails closed as a protected push with an unknown branch, the way `git "$X"` already does, instead of classifying to nothing.
- 31cc91e: Read NUL in text a shell reads on stdin the way zsh does: zsh keeps it in the stream and cuts a word at it only where the word reaches an external program, so `printf 'git\0xyz push origin HEAD:main\n' | zsh` classifies as a protected push, including when the NUL sits in a wrapper's name or option word. The text of `eval`, assignments and `echo` keeps its NUL. bash, sh and dash keep the NUL-dropped reading; zsh and ksh are read both ways.
- b7bd8ef: Classify a script piped into a shell from a `{ }` group, a `( )` subshell or a process substitution read as stdin (`bash < <(printf ...)`), with the same NUL readings a plain pipe gets.
- 560de7c: The shell lexer's spaced-subscript scan now skips `$( )`, backtick spans and `${ }` holding a `]`, so `Y[ $(echo ]) ]=x git push origin HEAD:main` keeps the assignment as one word and the push is still classified. An unterminated span falls back to the plain split.

  A `$( )` or backtick span that holds a `[` is scanned character by character as before, since a nested subscript there can hold a closing `)` the scan cannot match.

  A `[` in a `${ }` body is scanned the same way, since bash honours a nested subscript there.

- dfc7e49: Keep a spaced subscript assignment joined when an unplaceable form such as a comment holding `((` follows it, so the push after it stays visible.
- 9ed502b: Read a dynamic command word (`"$G" push origin HEAD:main`) as each guarded command whose verb follows it, so a guarded push, merge or release behind a variable is classified instead of passing; a word followed by no guarded verb gives no verdict.
- d958b08: Read `<<` and `<<=` inside an arithmetic command `(( ))` as shift operators, not heredoc openers, so a command on the next line is no longer swallowed as heredoc body.
- 8e9de56: A wrapper's short option cluster that holds a digit (`xargs -0I {}`, `xargs -0n 1`, `env -0u X`) is now split option by option, so its value is skipped and the wrapped command is classified.
- dd84387: Every wrapper short-option reader (`takesValue`, the xargs replace, batch and delimiter readers) now splits a cluster through one tokenizer, so a digit-led cluster such as `xargs -0I %` is read the same as `xargs -0 -I %`.

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
