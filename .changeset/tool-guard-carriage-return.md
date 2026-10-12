---
"@titan-design/tool-guard": patch
---

Read a carriage return as an ordinary word character, as bash does, so `echo x<CR>#; git push` and a CRLF `<<-E<CR>` heredoc no longer hide a command from the guard (TP-2432).
