---
"@titan-design/titan": patch
---

titan imports the systemd escaping, PATH, unit-directory and node-path helpers from `@titan-design/daemon/service` and deletes its own copies. Rendered unit files are byte-identical, except that a node directory containing ":" now throws instead of writing a broken PATH.
