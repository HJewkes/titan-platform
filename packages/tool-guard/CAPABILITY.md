# tool-guard: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

A hook or guard must see what a Bash command string would actually run: every simple command through `;`, `&&`, pipes, subshells, substitutions, `bash -c`, `eval`, wrappers and package runners, with redirect targets, heredoc bodies, decoded ANSI-C strings and literal variables kept. `@titan-design/tool-guard/shell` is pure and never runs the command. `classify` turns a parsed PreToolUse event into the guarded actions it would take (a merge, a release, a credential read, a permission-config edit, data sent off the host allowlist) with no actor attached, `decide` applies the authority table, and the `titan-tool-guard` bin is the PreToolUse hook that denies them; the owner installs it by hand.
