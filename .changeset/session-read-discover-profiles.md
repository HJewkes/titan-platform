---
"@titan-design/session-read": patch
---

`claudeTranscriptRoots` now discovers Claude config profiles through `@titan-design/anthropic-account` instead of its own copy of the scan. Two behaviour changes follow from that package: a symlinked `~/.claude-profiles` directory is skipped, and an account label drops leading dots (a `CLAUDE_CONFIG_DIRS` entry `.work` is now labelled `work`, and a name that is empty after that is labelled `default`), so stored account names for such directories change. The default `~/.claude` root is still always listed.

Release order: `@titan-design/anthropic-account` is a new package whose first npm publish is done by the owner. Hold the "Version Packages" pull request until that package exists on npm, because this release depends on it.
