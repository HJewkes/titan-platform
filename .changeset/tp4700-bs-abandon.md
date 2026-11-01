---
"@titan-design/factory": minor
---

Add `titan-factory build-surface abandon <run> --reason <text>` (`factory.build-surface.abandon` on serve), which ends a build-surface run whose PR was merged outside Shepherd and cancels its open gates with the reason. It refuses while a PR the run opened is still open unless `--force`.
