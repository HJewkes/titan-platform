---
"titan-console": minor
---

Tap a deposit's `close-pr` op from the inbox (TP-3939 S4). `close-pr` joins `CONSOLE_OPS`, so its deposit gets a "Close PR" tap whose read-back says "Close `<repo>#<n>` at `<head>` on GitHub; the branch is kept and reopen is one click". The factory's `pr-closed` answer reads as "PR closed at `<head>`; its branch is kept", lands as a success, and the next state reads the PR closed.
