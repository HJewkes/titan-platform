---
"@titan-design/embed": minor
---

Extract the embedder layer from brain: the `Embedder` interface, an Ollama embedder over
plain fetch (local and remote collapse into one class), an in-process `LocalEmbedder` with
`@huggingface/transformers` as an optional peer, a new zero-download `HashEmbedder` fallback,
`createEmbedder` with probe-and-fall-back, and float32 vector helpers.
