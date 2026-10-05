---
"@titan-design/tool-guard": patch
---

Read every short wrapper option that takes a separate value, so its value is no longer read as the command: sudo `-a`, `-c`, `-R` and `-T`, env `-a`, BSD env `-P` and FreeBSD env `-L` and `-U`, BSD xargs `-J`, `-R` and `-S`, and GNU time `-f` and `-o` (with `--format`, `--output` and their abbreviations). `sudo -R / git push origin HEAD:main` now classifies as the push it runs.
