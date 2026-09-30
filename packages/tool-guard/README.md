# @titan-design/tool-guard

POSIX shell tokenizer and command extraction for tool-call guards

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Status: private and unpublished while TP-403 lands in slices. This slice (TP-488) ships the
`./shell` entry only; the classifier, hook and bin follow.

## `@titan-design/tool-guard/shell`

```ts
import { extractCommands, parseGit } from "@titan-design/tool-guard/shell";

const commands = extractCommands('F=~/.x; cd /repo && git -C sub push origin "$F"', {
  cwd: "/work",
  home: "/home/you",
});
// [{ name: "git", args: [...], env: {}, redirects: [], dir: "/repo" }]
const inv = parseGit(commands[0].args, commands[0].dir, "/home/you");
// inv.dir === "/repo/sub", inv.sub === "push"
```

- `tokenize(src)` returns words, operators, redirections (with their targets and heredoc
  bodies) and process substitutions. Throws `ParseError` on unterminated quoting.
- `extractCommands(src, { cwd, home })` returns every simple command the shell would run,
  each with its working directory. Literal assignments (`F=~/.x; cat "$F"`) and `$HOME` are
  expanded; anything computed stays `dynamic`.
- `parseGit` and `splitArgs` read git's global options and flag clusters.

Nothing here touches the filesystem, the environment or a clock.

Ported from the owner's git-safety PreToolUse hook, with four additions: redirect targets
and heredoc bodies are kept, `$'...'` strings are decoded, and literal variables are
tracked within one command string.
