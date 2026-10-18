---
"@titan-design/tool-guard": patch
---

Read a `$(( ))` body as plain math when its nested spans hold only plain text, so common timing and counting lines such as `$(( $(date +%s) - start ))`, `$(( ${n:-0} + 1 ))`, `$(( ${#a[@]} * 2 ))` and `$(( 16#ff ))` are allowed again. A nested span holding a quote, backslash, comment, paren, separator, newline or heredoc is still read both ways.
