---
"@titan-design/github": minor
---

`fileBytes(repo, path, ref, { maxBytes })` refuses a file whose contents entry reports a size over `maxBytes`, or no numeric size, by throwing the new `BlobTooLargeError` before any `git/blobs` download. `GitHubWire.getContentBytes` takes the cap as a fourth argument, the port refuses a cap that is not a positive integer, and the fake refuses stored bytes over the cap the same way.
