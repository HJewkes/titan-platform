---
"@titan-design/evals": minor
---

Attach screened later-fix tests to implement-task cases (TP-2901 c). After the primary screen keeps a case, `titan-evals implement-task export` follows its later fix PRs (`--later-fix-source follow-up|fix-touch|both`, default `both`; `--no-later-fixes` turns this off), builds each fix's corrected reference in the scratch clone and screens it with the accepted merge as base. An attached fix's tests go to `expected.laterFixTests` and `expected.laterFixSupport` `[{path, sha256, sourcePr, sourceSha, fixSource}]`, with files under `hidden/<id>/fix-<pr>/` read at the corrected reference. The manifest's `laterFixPrs` list is replaced by `laterFix: {attached, rejected, counts}`, each rejection with its reason. The corpus parser now keeps `fix_touch_14d`. Without later fixes, case bytes are unchanged.
