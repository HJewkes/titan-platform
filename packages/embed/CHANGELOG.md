# @titan-design/embed

## 0.1.0

### Minor Changes

- c9a2dd2: Extract the embedder layer from brain: the `Embedder` interface, an Ollama embedder over
  plain fetch (local and remote collapse into one class), an in-process `LocalEmbedder` with
  `@huggingface/transformers` as an optional peer, a new zero-download `HashEmbedder` fallback,
  `createEmbedder` with probe-and-fall-back, and float32 vector helpers.
