# explainer: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You are building a step of the explainer video pipeline and need its file contracts or its pure helpers: `StoryboardSchema` validates `beats.json` (video type, chapters, beats with stops in seconds), `DigestSchema` validates `digest.json`, `LexiconSchema` and `lexiconEntriesFor` cover pronunciations, `buildPacket` builds one beat builder's packet (throws on a code beat with no excerpt and on a packet over its byte cap), and `attributeFindings` maps gate findings to the beat each names by beat number. It makes no model, network or filesystem calls. Motion primitives and beat components live in `@titan-design/react-ui`, not here; citation checks live in `evidence`.
