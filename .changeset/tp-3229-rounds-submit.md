---
"titan-console": patch
---

Add the `rounds.submit` owner-write command: it writes a round's `feedback.json` in the `feedback@1` shape exactly once (`wx`, mode 0600), bound to the sha256 of the `round.json` the owner was shown and, for a merge-bound Ship, the head sha the question names. It refuses unsafe or unknown round ids, unknown question ids, options a question does not offer and feedback over 64 KiB, and returns the written path and sha256. A second submit answers `already-submitted`.
