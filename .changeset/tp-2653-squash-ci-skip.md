---
"@titan-design/github": minor
"@titan-design/factory": patch
---

`formatSquashMessage` defangs CI skip tokens (TP-2653). The five bracketed skip forms GitHub documents (skip ci, ci skip, no ci, skip actions, actions skip), in any case or inner spacing, have their square brackets turned into parentheses, and a skip-checks trailer set to true loses its colon, in the subject and the whole body, code included, so a squash merge can no longer skip main CI and Release. Re-formatting the output still changes nothing. The rewrite is exported as `defangCiSkip`, and the factory's squash fallback (plain title when formatting throws) applies it to the title.
