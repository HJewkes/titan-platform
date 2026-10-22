---
"@titan-design/factory": minor
---

Add `titan-factory planner wake --config <path>`, the factory-planner timer's entry. It hashes the planner's configured inputs (files, task directories, command output such as merged PRs) with timestamps normalized away, and exits 0 with one line when they match the last run, so an unchanged factory costs no model call. Files the planner writes itself are re-baselined after each spawn. The spawn profile is configurable (`profile`, or `--profile`) and defaults to `opus-coordinator`. Inputs marked `digest` are copied into a pre-digest file, cut to `digestMaxTokens` (60k by default), and the brief points the planner at it first.
