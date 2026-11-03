import { DOCS } from "./git-shim-pin.js";

// Global options whose value is the next word; every other leading dash word stands alone.
const VALUED_GLOBALS = "-C | -c | --git-dir | --work-tree | --namespace | --config-env | --attr-source | --super-prefix | --shallow-file";

// Every text filter runs as `LC_ALL=C`, so a byte that is not valid UTF-8 cannot make tr fail and blank a check; a failure still refuses.
const FILTER_FAILED = 'refuse unresolved "a text filter failed, so the shim cannot tell whether this is a push."';

// Pure sh, no fork: sets q to $1 single-quoted for eval.
export const QUOTE_FN = `sq="'"
quote() {
  q= rest=$1
  while :; do
    case $rest in
    *"$sq"*) q="$q\${rest%%"$sq"*}'\\\\''"; rest=\${rest#*"$sq"} ;;
    *) q="'$q$rest'"; return ;;
    esac
  done
}`;

export const REFUSE_FN = `refuse() {
  printf '%s\\n' "git-shim: push refused ($1): $2 ${DOCS}" >&2
  exit 2
}`;

// A refused shell alias need not be a push, so this reason does not say "push refused".
export const REFUSE_ALIAS_FN = `refuse_alias() {
  printf '%s\\n' "git-shim: refused (shell-alias): $1 ${DOCS}" >&2
  exit 2
}

listed() {
  for listed_name in $shell_aliases; do
    [ "$listed_name" = "$1" ] && return 0
  done
  return 1
}`;

// git's split_cmdline: quotes group, a backslash escapes outside single quotes, an open quote fails.
export const SPLIT_FN = `tab='	'
nl='
'
split() {
  s=$1 words= word= started= quoted=
  while [ -n "$s" ]; do
    c=\${s%"\${s#?}"}
    s=\${s#?}
    if [ -z "$quoted" ]; then
      case $c in
      ' ' | "$tab" | "$nl")
        [ -z "$started" ] || { quote "$word"; words="$words $q"; word= started=; }
        continue ;;
      \\' | \\") quoted=$c started=1; continue ;;
      esac
    elif [ "$c" = "$quoted" ]; then
      quoted=
      continue
    fi
    if [ "$c" = \\\\ ] && [ "$quoted" != \\' ]; then
      [ -n "$s" ] || return 1
      c=\${s%"\${s#?}"}
      s=\${s#?}
    fi
    word=$word$c started=1
  done
  [ -z "$quoted" ] || return 1
  [ -z "$started" ] || { quote "$word"; words="$words $q"; }
}`;

// A direct remote-ext call runs its argument as a shell command without the GIT_ALLOW_PROTOCOL check.
export const REFUSE_EXT_FN = `refuse_ext() {
  printf '%s\\n' "git-shim: refused (ext-transport): git remote-ext runs its argument as a shell command, which GIT_ALLOW_PROTOCOL does not stop. ${DOCS}" >&2
  exit 2
}`;

// help.autocorrect would run a command the shim never checked; only values git documents as "do not run" pass.
export const AUTOCORRECT_FN = `autocorrect_off() {
  ac=$(eval "\\"\\$real\\"$globals config --get --type=bool-or-int help.autocorrect" 2>/dev/null)
  case $? in
  1) return 0 ;;
  0) case $ac in false | 0) return 0 ;; esac; return 1 ;;
  esac
  ac=$(eval "\\"\\$real\\"$globals config --get help.autocorrect" 2>/dev/null)
  case $ac in never | show) return 0 ;; esac
  return 1
}`;

// git's own "most similar command" list for a word, read with autocorrect off so nothing runs.
export const TYPO_FN = `refuse_typo() {
  similar=$(eval "\\"\\$real\\"$globals -c help.autocorrect=0 \\"\\$1\\"" 2>&1)
  case $similar$nl in *"$tab"push"$nl"*)
    refuse autocorrect "$1 is not a git command and help.autocorrect would run its correction unchecked; set it to show or never." ;;
  esac
  printf '%s\\n' "git-shim: refused (autocorrect): '$1' is not a git command and help.autocorrect would run git's guess at it unchecked; fix the typo, or set help.autocorrect to show or never. ${DOCS}" >&2
  exit 2
}`;

// A word git finds as git-<word> on its exec path or PATH runs that command, so git never autocorrects it.
export const EXTERNAL_FN = `external() {
  case $1 in */*) return 1 ;; esac
  saved=$PATH
  PATH=\${exec_path:+$exec_path:}$PATH
  command -v "git-$1" >/dev/null 2>&1
  found=$?
  PATH=$saved
  return $found
}`;

// git stash push is not a push; push passes only right after stash as git's subcommand, past its global options.
export const MENTIONS_PUSH_FN = `mentions_push() {
  stripped=$(printf '%s' "\${1#!}" | LC_ALL=C tr -d "\\"'\\\\\\\\") || ${FILTER_FAILED}
  set -f
  set -- $stripped
  set +f
  at=
  for tok; do
    case $at in
    globals)
      case $tok in
      ${VALUED_GLOBALS}) at=value ;;
      -*) ;;
      stash) at=stash ;;
      *) at= ;;
      esac ;;
    value) at=globals ;;
    stash) at=; [ "$tok" = push ] && continue ;;
    *) [ "$tok" = git ] && at=globals ;;
    esac
    case $tok in *push*) return 0 ;; esac
  done
  return 1
}`;

// git appends the arguments to a ! alias, which may read, glob, decode or eval them, so push in any case, a glob, an escape or a $, backtick or { counts.
export const ARGS_PUSH_FN = `args_push() {
  flat=$(printf '%s' "$*" | LC_ALL=C tr -d " \\t\\n\\"'") || ${FILTER_FAILED}
  flat=$(printf '%s' "$flat" | LC_ALL=C tr A-Z a-z) || ${FILTER_FAILED}
  case $flat in *push* | *'\\'* | *'?'* | *'*'* | *'['* | *'$'* | *'\`'* | *'{'*) return 0 ;; esac
  return 1
}`;

// A listed name runs only the body in the config files the agent had at spawn: a -c, --config-env or
// GIT_CONFIG_* value, an include one adds, or a HOME, XDG_CONFIG_HOME or GIT_CONFIG_* file swap must not replace it.
export const SHADOWED_FN = `shadowed() {
  origins=$(eval "\\"\\$real\\"$globals config --show-origin --get-all \\"alias.\\$1\\"" 2>/dev/null) || return 0
  case $nl$origins in *"$nl"'command line:'*) return 0 ;; esac
  body=$(unset GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM HOME XDG_CONFIG_HOME
    [ -z "$spawn_home" ] || export HOME="$spawn_home"
    [ -z "$spawn_xdg" ] || export XDG_CONFIG_HOME="$spawn_xdg"
    eval "\\"\\$real\\"$fileglobals config --get \\"alias.\\$1\\"" 2>/dev/null) || return 0
  [ "$body" != "$alias" ]
}`;

// TP-4249: a bare --exec-path only prints; a dir other than the mirror would undo the pin for git's child shells.
export const FOREIGN_EXEC_PATH_FN = `foreign_exec_path() {
  case $1 in --exec-path=*) [ -z "$mirror" ] || [ "\${1#--exec-path=}" != "$mirror" ] ;; *) return 1 ;; esac
}`;

// Fails closed: a word it cannot resolve, or an alias chain past the cap, refuses rather than execs.
export const RESOLVE_FN = `resolve() {
  globals= fileglobals= cmdglobals= depth=0
  while [ $# -gt 0 ]; do
    case $1 in
    ${VALUED_GLOBALS})
      [ $# -ge 2 ] || return 1
      quote "$1"; globals="$globals $q"; option=$q; quote "$2"; globals="$globals $q"
      case $1 in -c | --config-env) cmdglobals="$cmdglobals $option $q" ;; *) fileglobals="$fileglobals $option $q" ;; esac
      shift 2; continue ;;
    -*)
      foreign_exec_path "$1" &&
        refuse_pin exec-path "--exec-path=<dir> makes git run its helpers, and the git its shells find, from a dir other than the shim's mirror."
      quote "$1"; globals="$globals $q"
      case $1 in -c?* | --config-env=*) cmdglobals="$cmdglobals $q" ;; *) fileglobals="$fileglobals $q" ;; esac
      shift; continue ;;
    push) break ;;
    remote-ext) refuse_ext ;;
    esac
    case " $builtins " in *" $1 "*) return 1 ;; esac
    alias=$(eval "\\"\\$real\\"$globals config --get \\"alias.\\$1\\"" 2>/dev/null)
    case $? in
    0) ;;
    1)
      external "$1" || autocorrect_off || refuse_typo "$1"
      return 1 ;;
    *) refuse unresolved "git could not read alias.$1, so the shim cannot tell whether this is a push." ;;
    esac
    case $alias in
    !*)
      name=$1
      listed "$name" ||
        refuse_alias "alias.$name runs a shell command and is not on the shell alias allowlist; run the command directly."
      shadowed "$name" &&
        refuse_alias "alias.$name is on the shell alias allowlist but is set by -c, --config-env, GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT or an include they add; only its config file text runs."
      shift
      args_push "$@" &&
        refuse shell-alias "alias.$name is an allowlisted shell alias and its arguments mention push or hold a glob, backslash, $, backtick or brace; run the command directly."
      mentions_push "$alias $*" &&
        refuse shell-alias "alias.$name is an allowlisted shell alias and the command mentions push; run git push directly."
      return 1 ;;
    esac
    split "$alias" || refuse unresolved "alias.$1 has an open quote or a trailing backslash."
    depth=$((depth + 1))
    [ "$depth" -le 10 ] || refuse alias-depth "alias.$1 is more than 10 aliases deep."
    shift
    eval "set -- $words \\"\\$@\\""
  done
  [ $# -gt 0 ] || return 1
  shift
  pushargs=
  for word; do
    case $word in --no-veri*) refuse no-verify "git push --no-verify skips the pre-push leak scan." ;; esac
    quote "$word"; pushargs="$pushargs $q"
  done
}`;
