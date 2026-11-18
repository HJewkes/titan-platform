# seat-spec: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You launch a standing seat and the owner's definition, not the requester, must decide its profile, account, permission mode, surface, cwd, depth and Remote Control. `loadSeat` takes what a thin reader saw (lstat facts and bytes for the `titan-seat/v1` file, the seat index and the pinned prompt) and refuses with a named code on any unreadable file, unsafe owner or mode, unknown or missing field, bypass mode, headless surface, prompt hash mismatch or unlisted `ownerOnlyRead`; `resolveLaunch` then builds the launch from the definition alone and lists the requester fields it overrode. It does no I/O. For an autonomy coordinator's `autonomy-seat/v1` front matter use coordinator.
