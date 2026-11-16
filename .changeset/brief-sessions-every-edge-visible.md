---
"@titan-design/active-work": patch
---

`context.brief`'s recent-sessions section lists a session only when every initiative its task edges name is shown to agents, so a session that also worked in an owner-only initiative, or in one whose visibility is unknown, is withheld (TP-5986). A session with no task edges maps to an initiative by its cwd's folder under the configured active root, whatever that root is named, instead of an `active-work/` path match (TP-5987); `why` uses the same mapping.
