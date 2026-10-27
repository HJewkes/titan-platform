#!/bin/sh
# Stand-in for `codex login status` in the login-probe tests. It is committed rather than written by
# the test because exec'ing a file a vitest thread just wrote races sibling threads' forks for ETXTBSY.
# FAKE_CODEX_OUTPUT goes to stderr and FAKE_CODEX_EXIT is the exit code; any other argv exits 99.
[ "$*" = "login status" ] || exit 99
printf '%s\n' "$FAKE_CODEX_OUTPUT" >&2
exit "$FAKE_CODEX_EXIT"
