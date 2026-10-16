---
"@titan-design/tool-guard": patch
---

Read what a shell runs from stdin, or from another descriptor its script operand names, in one place: `shellStdin` in `shell/shell-options.ts`. The inline walk, the script-file target and the IFS check all use its answer. A `<` or `<>` file is now read when the operand names stdin or a descriptor (`bash /dev/stdin < ./x.sh`, `zsh /dev/fd/0 < ./x.sh`, `sh /proc/self/fd/0 < ./x.sh`, `bash /dev/fd/3 3< ./x.sh`), and every source opened on that descriptor is read, the pipe included, as zsh's MULTIOS joins them. A redirect target that names a descriptor (`< /dev/stdin`, `3< /dev/stdin`, `< /dev/fd/3`) feeds what that descriptor held, so `echo TEXT | bash < /dev/stdin` still reads the pipe, and `00<` is stdin. A shell that runs a descriptor the line cannot show is refused: `bash < $F`, `bash /dev/stdin <&3`, or an inherited `bash /dev/fd/3`. A script operand known only at run time may name stdin, so its stdin is read too (TP-3241).
