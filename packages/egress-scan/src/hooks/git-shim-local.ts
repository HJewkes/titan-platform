export const CFG_FN = `cfg() {
  eval "\\"\\$real\\"$globals config \\"\\$@\\""
}`;

// Sets vals to one "=<value>" line per value; a read error or a value holding a newline is status 2.
export const VALUES_FN = `soh=$(printf '\\001')
values() {
  vals=
  cfg --get-all "$1" >/dev/null 2>&1
  case $? in 0) ;; 1) return 1 ;; *) return 2 ;; esac
  raw=$({ cfg -z --get-all "$1" 2>/dev/null || echo "$soh"; } | LC_ALL=C tr '\\n\\0' '\\001\\n') || return 2
  vals=$(printf '%s\\n' "$raw" | LC_ALL=C sed 's/^/=/') || return 2
  case $vals in *"$soh"*) return 2 ;; esac
}`;

// git's url_is_local_not_ssh: a colon before any slash is a URL, a <transport>:: helper or host:path.
export const IS_LOCAL_FN = `is_local() {
  case $1 in
  '') return 1 ;;
  file://*) return 0 ;;
  esac
  head=\${1%%:*}
  [ "$head" = "$1" ] && return 0
  case $head in */*) return 0 ;; esac
  return 1
}`;

// Adds a URL and every insteadOf or pushInsteadOf rewrite of it to cands: a superset of what git sends to.
export const EXPAND_FN = `expand() {
  cands="$cands$nl=$1"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    values "$key"; [ $? -le 1 ] || return 1
    base=\${key#url.}; base=\${base%.*}
    while IFS= read -r v; do
      [ -n "$v" ] || continue
      v=\${v#=}
      case $1 in "$v"*) cands="$cands$nl=$base\${1#"$v"}" ;; esac
    done <<EOF
$vals
EOF
  done <<EOF
$rules
EOF
}`;

// A remote's pushurls, else its urls, else the word itself as a URL, the way git's remote_get reads it.
export const DESTINATIONS_FN = `destinations() {
  case $1 in '' | . | .. | */*) expand "$1"; return ;; esac
  for key in vcs receivepack; do
    values "remote.$1.$key"; [ $? -eq 1 ] || return 1
  done
  [ ! -e "$common/remotes/$1" ] && [ ! -e "$common/branches/$1" ] || return 1
  values "remote.$1.pushurl"
  case $? in
  0) ;;
  1) values "remote.$1.url"; case $? in 0) ;; 1) vals="=$1" ;; *) return 1 ;; esac ;;
  *) return 1 ;;
  esac
  while IFS= read -r u; do
    [ -z "$u" ] || expand "\${u#=}" || return 1
  done <<EOF
$vals
EOF
}`;

// git's pushremote_for_branch; every value counts, and a detached HEAD fails closed.
export const DEFAULT_REMOTE_FN = `default_remote() {
  ref=$(eval "\\"\\$real\\"$globals symbolic-ref -q HEAD" 2>/dev/null) || return 1
  case $ref in refs/heads/?*) b=\${ref#refs/heads/} ;; *) return 1 ;; esac
  for key in "branch.$b.pushRemote" remote.pushDefault "branch.$b.remote"; do
    values "$key"
    case $? in 0) repos="$repos$nl$vals"; return 0 ;; 1) ;; *) return 1 ;; esac
  done
  repos="$repos$nl=origin"
}`;

// A short-option cluster of push's valueless flags, which may end in -o taking the next word.
export const CLUSTER_FN = `cluster() {
  rest=\${1#-}
  while [ -n "$rest" ]; do
    c=\${rest%"\${rest#?}"}
    rest=\${rest#?}
    case $c in
    [46dfnquv]) ;;
    o) [ -n "$rest" ] || skip=value; return 0 ;;
    *) return 1 ;;
    esac
  done
}`;

const PUSH_TOGGLES = [
  "verbose",
  "quiet",
  "all",
  "branches",
  "mirror",
  "delete",
  "tags",
  "dry-run",
  "porcelain",
  "force",
  "force-with-lease",
  "force-if-includes",
  "thin",
  "set-upstream",
  "progress",
  "prune",
  "follow-tags",
  "signed",
  "atomic",
];

// Flags that take no value and cannot change where a push goes; any other option fails closed.
const PLAIN_FLAGS = [
  ...PUSH_TOGGLES.flatMap((flag) => [`--${flag}`, `--no-${flag}`]),
  ...["repo", "recurse-submodules", "push-option", "receive-pack", "exec"].map((flag) => `--no-${flag}`),
  "--verify",
  "--ipv4",
  "--ipv6",
].join(" | ");

// Sets repos to the repository words a push names; --receive-pack, --exec and submodule pushes fail closed.
export const PUSH_REPOS_FN = `push_repos() {
  repos= skip= positional= ended=
  for w; do
    case $w in *"$nl"*) return 1 ;; esac
    case $skip in
    repo) repos="$repos$nl=$w"; skip=; continue ;;
    value) skip=; continue ;;
    submodules) case $w in check | no) skip=; continue ;; esac; return 1 ;;
    esac
    [ -n "$ended" ] || case $w in
    --) ended=1; continue ;;
    --repo) skip=repo; continue ;;
    --repo=*) repos="$repos$nl=\${w#--repo=}"; continue ;;
    -o | --push-option) skip=value; continue ;;
    --recurse-submodules) skip=submodules; continue ;;
    -o?* | --push-option=* | --force-with-lease=* | --signed=* | --recurse-submodules=check | --recurse-submodules=no | ${PLAIN_FLAGS}) continue ;;
    -[46dfnquv]*) cluster "$w" || return 1; continue ;;
    -*) return 1 ;;
    esac
    [ -n "$positional" ] || positional=$w
  done
  [ -z "$skip" ] || return 1
  if [ -n "$positional" ]; then repos="=$positional"; else default_remote; fi
}`;

export const SUBMODULES_OFF_FN = `submodules_off() {
  for key in push.recurseSubmodules submodule.recurse; do
    ac=$(cfg --get "$key" 2>/dev/null)
    case $? in 1) continue ;; 0) ;; *) return 1 ;; esac
    case $ac in no | false | check | 0 | off) ;; *) return 1 ;; esac
  done
}`;

// True only when every destination of this push is a path or file:// URL, which cannot leave the machine.
export const LOCAL_ONLY_FN = `local_only() {
  common=$(eval "\\"\\$real\\"$globals rev-parse --path-format=absolute --git-common-dir" 2>/dev/null) || return 1
  rules=$(cfg --name-only --get-regexp '^url\\..*\\.(push)?insteadof$' 2>/dev/null)
  case $? in 0 | 1) ;; *) return 1 ;; esac
  submodules_off || return 1
  eval "set -- $pushargs"
  push_repos "$@" || return 1
  cands=
  while IFS= read -r r; do
    [ -z "$r" ] || destinations "\${r#=}" || return 1
  done <<EOF
$repos
EOF
  [ -n "$cands" ] || return 1
  while IFS= read -r c; do
    [ -z "$c" ] || is_local "\${c#=}" || return 1
  done <<EOF
$cands
EOF
}`;

export const HOOKS_CHECK = `hooks=$(eval "\\"\\$real\\"$globals config --get core.hooksPath" 2>/dev/null)
[ "$hooks" = "$guard" ] || local_only ||
  refuse hooks-path "core.hooksPath is not the leak guard's hooks dir and a destination is not a local repository, so the pre-push leak scan would not run."`;
