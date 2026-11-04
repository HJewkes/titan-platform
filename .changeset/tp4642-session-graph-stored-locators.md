---
"@titan-design/agent-protocol": minor
"@titan-design/session-graph": minor
---

Add the `@titan-design/agent-protocol/source-schema` subpath: `SessionSourceDescriptorSchema`, `SourceTextLocatorSchema` and `UsageMeasurementSchema`, loose zod schemas for stored source descriptors, text locators and usage measurements. Keys a newer writer added survive a parse; `lifecycle-schema` now reads usage through the same schema.

`session-graph` parses its stored columns with them. `readIndexedText` returns null for a malformed stored descriptor or locator list instead of throwing or reading through it. `normalizedUsage` skips a usage row that does not parse and reports it through a new `warn` option (default `console.warn`), so the remaining rows still sum. `zod` is now a peer dependency of `session-graph`.
