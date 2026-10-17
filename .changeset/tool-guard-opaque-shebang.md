---
"@titan-design/tool-guard": patch
---

Refuse a `.sh` run by path whose `#!` line carries options or operands the guard does not follow (`-s`, an operand script, `env -S`, `-xc` clusters); `#!/bin/bash`, one `-[euxvf]+` word, `#!/usr/bin/env bash` and no `#!` line read as before.
