---
"@titan-design/evals": patch
---

Add the model-routing benchmark's implement-track case builder (TP-5756, S5). It joins Shepherd registrations (read-only), task files and main's squash merges into corpus rows tagged by kind, size and package group, scrubs each brief to title and done_when, and orders the eligible PRs into a seeded, stratified queue. Each candidate goes through `exportImplementTaskCases` alone, and a kept case gets a prepared base: a one-commit repo, installed offline and built, which `copyPreparedBase` copies per arm.
