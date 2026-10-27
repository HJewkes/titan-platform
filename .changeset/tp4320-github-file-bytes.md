---
"@titan-design/github": minor
---

Add `fileBytes(repo, path, ref)` to `GitHubPort` and `getContentBytes` to `GitHubWire`: a byte-exact file read for binary content such as PNG snapshots, which `getFile` corrupts by decoding UTF-8. A file the contents API does not inline (over 1 MB, `encoding: "none"`) is read through `git/blobs/{sha}`, and a decoded length that differs from the reported size throws. The fake gains a `bytes` map, falling back to `files` encoded as UTF-8.
