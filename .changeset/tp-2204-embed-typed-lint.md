---
"@titan-design/embed": patch
---

Narrow the Ollama response and the optional transformers import with type guards instead of assertions. A response whose embeddings are not number arrays now fails with the embedding-count error.
