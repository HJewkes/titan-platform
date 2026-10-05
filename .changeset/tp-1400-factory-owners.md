---
"@titan-design/factory": patch
---

The state directory, the settled-run wait and the CLI exit codes each have one owner now: `serviceLogDir` is gone in favour of `factoryStateDir`, the in-process land wait is the host's `untilSettledOrGated`, and `gate resolve` shares `EXIT` and `stepIdMatches` instead of repeating them.
