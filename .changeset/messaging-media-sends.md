---
"@titan-design/messaging": minor
---

`InteractiveTransport` gains `sendVoice({ handle, audio })` and `sendPhoto({ handle, image, caption })`, and `ChannelCapabilities` gains `media`. Both take bytes (`MediaFile`) and answer a `MediaSendResult`. Telegram uploads multipart form data with the chat id to `sendVoice` and `sendPhoto`, defaults the file label to OGG voice and JPEG photo, fails a caption over 1024 characters as `too-long` before any call, and reports a 429 as `rate-limited` with `retryAfterSeconds`. BlueBubbles answers `unsupported` with capability `media` and makes no request. `MockTransport` logs `sendVoice` and `sendPhoto` events and refuses them when `media` is off. A consumer's own `InteractiveTransport` implementation or `ChannelCapabilities` literal must add the two methods and the flag.
