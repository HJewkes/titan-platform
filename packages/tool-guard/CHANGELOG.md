# @titan-design/tool-guard

## 0.0.1

### Patch Changes

- 4ff5b0a: `xargs -I` now runs its command once per input line, so a push on a later line of piped text, a here-string or a heredoc is classified as a push. A line that is only the replace string is read as shell words.
- 7851c2d: Model `xargs -L N` and `-n N` as one command per batch of lines or arguments, read an unreadable `-d` value as a split on every character, and read a protected `git` or `gh` fed `{}` from unknown stdin as its worst case.
