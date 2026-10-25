# render-qa: use this when

You need to check a rendered page's layout at chosen moments (overlaps, off-frame, small or low-contrast text, wraps, frame rules) and separate held errors from transient ones before encoding. It drives any `__titanMotion` page through `frame-capture`; for the capture and encode themselves use `frame-capture`, and for the pure checks over boxes already measured use the explainer's `clippedText` and `contentFill`.
