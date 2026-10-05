---
"@titan-design/github": patch
---

Token redaction now covers `https://<hex>:x-oauth-basic@host`, a keyword and hex run split across stdout and stderr at any offset, percent-encoded separators (`%26token=`, `access_token%3D`, `Bearer%20<JWT>`), long gaps after `token:`, and JWTs with a short payload segment, and the keyword lookbehind is linear so a megabyte of whitespace no longer stalls it.
