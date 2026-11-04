---
"@titan-design/explainer": minor
---

The `explainer.resolve` stage builds custom layers. Each beat that resolves to `layer: "custom"` gets a layer packet. Its build runs as a `mapItems` item keyed by the packet and the builder (`packetKey`), so a replay reuses every build whose packet is unchanged. The built layers are stored as a `custom-layers` tree. A pinned `custom-layers` tree, or a script with no custom beats, runs no builds. A host's `beatWorker` does the building; with no worker set, custom beats are left unbuilt and a note says so. Resolve also reads `facts`, and its stage version changes, so cached resolve runs miss once.
