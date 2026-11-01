---
"@titan-design/factory": minor
---

Add `titan-factory build-surface abandon <run> --reason <text>` (`factory.build-surface.abandon` on serve), which ends a build-surface run whose PR was merged outside Shepherd and cancels its open gates with the actor and reason. It refuses unless every PR the run opened is merged or closed.
