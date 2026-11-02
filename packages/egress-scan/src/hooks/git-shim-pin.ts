import { SAFE_GIT_PROTOCOLS } from "@titan-design/worktree";

export const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export const DOCS = "See docs/leak-guard.md.";

// git config reads only $GIT_CONFIG while git ignores it for aliases and hooks, so every read the shim makes runs without it.
export const HIDE_GIT_CONFIG = `unset caller_git_config
case \${GIT_CONFIG+set} in set) caller_git_config=$GIT_CONFIG; unset GIT_CONFIG ;; esac`;
export const RESTORE_GIT_CONFIG = `[ -z "\${caller_git_config+set}" ] || export GIT_CONFIG="$caller_git_config"`;

// TP-4249: git puts its exec-path first on the PATH of every shell it starts, so pinning the mirror
// on every run makes such a shell's git the shim, even after an unset; a dashed name is the subcommand.
export const PIN_MIRROR = `[ -z "$mirror" ] || export GIT_EXEC_PATH="$mirror"
case \${0##*/} in git-?*) set -- "\${0##*/git-}" "$@" ;; esac`;

// agentEnv and launch-agent still export this exact list (CC-1587), so the shim reads it as unset.
const LEGACY_PIN = "file:git:http:https:ssh";

// CC-1095 without overriding config (CC-1336): an exported list outranks every protocol.*.allow, but a
// last GIT_CONFIG_COUNT pair outranks every config file and include, so git reads all other policy itself.
export const PIN_PROTOCOLS = `refuse_pin() {
  printf '%s\\n' "git-shim: refused ($1): $2 ${DOCS}" >&2
  exit 2
}
safe_protocols=${shQuote(SAFE_GIT_PROTOCOLS.join(":"))}
case \${GIT_ALLOW_PROTOCOL+set}:\${GIT_ALLOW_PROTOCOL-} in
: | set:${LEGACY_PIN}) unset GIT_ALLOW_PROTOCOL ;;
*)
  pinned= rest=$GIT_ALLOW_PROTOCOL:
  while [ -n "$rest" ]; do
    protocol=\${rest%%:*} rest=\${rest#*:}
    case :$safe_protocols: in *":$protocol:"*) [ -z "$protocol" ] || pinned=\${pinned:+$pinned:}$protocol ;; esac
  done
  export GIT_ALLOW_PROTOCOL="$pinned" ;;
esac
count=\${GIT_CONFIG_COUNT:-0}
case $count in *[!0-9]* | ??????????*) refuse_pin config-count "GIT_CONFIG_COUNT is not a count git reads." ;; esac
count=\${count#"\${count%%[!0]*}"} count=\${count:-0} i=0 last_key= last_value=
while [ "$i" -lt "$count" ]; do
  eval "[ -n \\"\\\${GIT_CONFIG_KEY_$i+set}\\" ] && [ -n \\"\\\${GIT_CONFIG_VALUE_$i+set}\\" ]" ||
    refuse_pin config-count "GIT_CONFIG_COUNT is $count but GIT_CONFIG_KEY_$i or GIT_CONFIG_VALUE_$i is unset."
  eval "last_key=\\$GIT_CONFIG_KEY_$i last_value=\\$GIT_CONFIG_VALUE_$i"
  i=$((i + 1))
done
if [ "$last_key" != protocol.ext.allow ] || [ "$last_value" != never ]; then
  eval "export GIT_CONFIG_KEY_$count=protocol.ext.allow GIT_CONFIG_VALUE_$count=never"
  export GIT_CONFIG_COUNT=$((count + 1))
fi`;

// Only -c, --config-env and GIT_CONFIG_PARAMETERS rank after the pin's pair, and git evaluates a
// command-line includeIf against this cwd, not a repo the command creates, so either refuses.
export const EXT_CHECK = `ext=$(eval "\\"\\$real\\"$cmdglobals config --get protocol.ext.allow" 2>/dev/null) ||
  refuse_pin ext-transport "git could not read its command-line config, so the shim cannot tell whether ext:: may run."
case $ext in [Nn][Ee][Vv][Ee][Rr]) ;; *)
  refuse_pin ext-transport "-c, --config-env or GIT_CONFIG_PARAMETERS sets protocol.ext.allow, and ext:: runs its URL as a shell command." ;;
esac
includes=$(eval "\\"\\$real\\"$cmdglobals config --show-scope --name-only --get-regexp '^include(if\\\\..*)?\\\\.path\\$'" 2>/dev/null)
case $? in 0 | 1) ;; *) refuse_pin ext-transport "git could not list its command-line includes." ;; esac
case $nl$includes in *"$nl"command"$tab"*)
  refuse_pin ext-transport "a command-line include or includeIf could set protocol.ext.allow where the shim cannot read it." ;;
esac`;
