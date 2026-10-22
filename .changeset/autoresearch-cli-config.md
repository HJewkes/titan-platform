---
"@titan-design/factory": minor
---

Add the `titan-factory autoresearch` command group (`start`, `resume`, `status`, `add-idea`, `milestone`) and the `autoresearch` config section. With the section set, the factory hosts the `autoresearch` and `autoresearch-validate` workflows, with ports built per target from the config. The new write commands are `autoresearch.start`, which refuses a target that has an unfinished run; `autoresearch.add-idea`, which writes to an fsynced owner inbox; and `autoresearch.milestone`, which caps looks at `maxLooks` and needs serve. The evaluator gains the `validate` port, which returns aggregates only over held-out cases, and the `registry` port. A failed `git fetch` at pin time is now retryable as `[pin-fetch]`.
