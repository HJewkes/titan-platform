---
"@titan-design/messaging": minor
---

Teach `MockTransport` the acknowledgement surface (TP-291). It now implements
`InteractiveTransport`: an ordered `log` of every call with the time it
happened, `messageAt(ref)` for what the person would see now,
`typingVisible(handle)` for five seconds on the injected clock or until the
next send, and a partial `capabilities` override so each degrade path is
testable. `failNext` takes an optional method name, so a rate-limited reaction
does not fail the reply after it, and an `InteractionError` as well as a
`SendError`.

Adds `ManualClock`, a `Scheduler` whose time moves only on `advance(ms)`, and
`fakeTextUpdate` / `fakeCallbackUpdate`, which build raw Bot API JSON so a door
under test still runs the real parser.

`sent`, `reset` and `failNext(error)` keep their 0.3.0 behaviour, and the
constructor still takes a bare clock function.
