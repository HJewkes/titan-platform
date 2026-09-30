# tool-guard: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

A hook or guard must see what a Bash command string would actually run: every simple command through `;`, `&&`, pipes, subshells, substitutions, `bash -c`, `eval`, wrappers and package runners, with redirect targets, heredoc bodies, decoded ANSI-C strings and literal variables kept. `@titan-design/tool-guard/shell` is pure and never runs the command. It decides nothing; the classifier and hook land in later TP-403 slices.
