---
"@titan-design/tool-guard": patch
---

Refuse a shell or `source` whose script operand may name an fd the line opened for reading (TP-3314). `exec {fd}< x.sh; bash /dev/fd/$fd`, `bash -c 'exec 3< x.sh; bash /dev/fd/3' 3<&-`, a `{name}` redirect on a builtin, function or group, and `exec < x.sh; bash` ran an unchecked script before. A run-time `/dev/fd/$fd` or `/proc/self/fd/$fd` operand is now refused like a literal one, and after any read-opening redirect on the line a dynamic shell operand is refused too.
