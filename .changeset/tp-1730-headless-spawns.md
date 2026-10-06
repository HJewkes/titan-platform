---
"@titan-design/factory": patch
---

Shepherd's main-red fixers and wake successors now spawn under the headless `bd-implementer` profile instead of the builtin `implementer`, which opened an iTerm pane nobody watches. Both paths share one `FACTORY_IMPLEMENTER_PROFILE` constant; the `FIXER_PROFILE` and `SUCCESSOR_PROFILE` exports are gone.
