---
"@titan-design/tool-guard": patch
---

An `xargs` run whose command word is dynamic (`xargs "$G" push origin HEAD:main`) now fails closed as a protected push with an unknown branch, the way `git "$X"` already does, instead of classifying to nothing.
