---
"@titan-design/github": minor
---

Add `GitHubPort.listFiles(repo, path, ref)` and the `listDirectory` wire call it rides on: the files directly under a directory at a ref, each with its blob sha, or null when nothing is there. A path that is a file throws, and so does a listing at GitHub's 1,000-entry contents cap, so a caller never reads a short list as complete. The fake lists the `files` keyed under the directory.
