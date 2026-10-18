---
"@titan-design/daemon": minor
---

Add `fileResponse(request, file, { contentType, cacheControl? })`: serves one already-resolved file with single-range `206`/`416` answers, HEAD, `Accept-Ranges` and `nosniff`, streaming from a `O_NOFOLLOW` open and refusing symlinks and non-regular files. Lets a daemon route serve media a browser can seek in.
