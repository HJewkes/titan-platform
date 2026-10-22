---
"titan-console": patch
---

Add `titan-console decisions file [<round.json>|-] [--seat <name>] [--initiative <slug>] [--json]`. A seat pipes a questions-only round@2 round on stdin and it lands in the console's own rounds dir as `<unit>-r<round>/` beside an `asker.json` naming the seat (default `AGENT_CHAT_NAME`) and initiative; the verb prints the round id, the asker and the `/#/rounds/<id>` URL. A round with variants or a merge-bound Ship question, or one the round@2 parser refuses, is refused and nothing is written. Once the owner sends the round, the round listener tells the asking seat through `agent-chat debug send` (`TITAN_CONSOLE_AGENT_CHAT_BIN`, default `agent-chat`) with a fixed-text message naming the round and its `feedback.json`, and keeps `notified.json` so it is sent once; a failed send is retried by the start-up sweep.
