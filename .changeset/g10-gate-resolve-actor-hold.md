---
"@titan-design/factory": patch
---

Shepherd holds a pull request `g10-adversary` when it changes who may resolve a gate: any file that builds a gate resolver or hands one to a resolve sink, and the checks those files rely on. A repo scan test fails when a new resolver site is not held. Test-only changes stay unheld.
