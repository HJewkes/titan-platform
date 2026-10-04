---
"@titan-design/tool-guard": patch
---

Drop NUL bytes from `echo` and `printf` text piped to a shell, as bash and sh do, so `printf 'git pu\0sh origin HEAD:main\n' | bash` is read as `git push`.
