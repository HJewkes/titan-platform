---
"@titan-design/factory": patch
---

The ci-red wake brief tells the fixer not to merge the base branch to re-run CI or to bring the PR up to date: Shepherd reruns flaky checks and merges the base itself at land time, so the fixer pushes only its fix. The conflict brief is unchanged.
