---
"@titan-design/fix-proof": patch
---

The sandbox now passes `setpriv --regid` the sandbox user's numeric primary gid instead of the user name, so a user whose primary group has another name (Debian's `nobody` is in `nogroup`) no longer fails with "failed to parse regid". A user whose gid cannot be resolved is refused rather than run unsandboxed.
