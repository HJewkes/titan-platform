---
"@titan-design/owner-queue": minor
---

Export `writeFileOnce(dir, name, body)` from `@titan-design/owner-queue/spool`. It writes a temp file and hard-links it into place, so a second or racing write never replaces the file and reports `created: false` with the existing path; a symlink at the name is not followed.
