---
"@titan-design/registry": patch
---

`flagToKey` and `readCommanderOption` now drop a trailing `<name>`, `[name]` or variadic `<names...>` placeholder and accept a short alias form such as `-s, --spawner <name>`. Before, `--spawner <name>` keyed as `spawner <name>` and the option was never read.
