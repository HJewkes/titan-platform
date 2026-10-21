---
"@titan-design/factory": patch
---

The fixer note on a console Send back now carries the owner's frame feedback: `frame <key> (<verdict>): <comment>` and one `  pin <n> at <x%>,<y%> [<target>]: <note>` line per pin, read from `feedback.json` `variants[]`. The general note is kept whole under the 4000-character cap and frame lines are cut first. A Send back with only frame comments is no longer refused as having no note.
