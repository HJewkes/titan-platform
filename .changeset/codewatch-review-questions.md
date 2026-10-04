---
"@titan-design/factory": minor
---

Shepherd's sh-review adds up to 3 questions from the head's `codewatch-report` artifact to the reviewer brief, for repos listed in `shepherd.review.codewatchRepos`. The step records `codewatch: { found, schema, questions }`. A missing artifact, a wrong schema or a failed fetch adds no questions, and the review proceeds.
