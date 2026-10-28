---
"@titan-design/factory": minor
---

The evidence step now measures each changed snapshot from the merge base to the head under `shepherd.visualThreshold` shadow (TP-4320 S3c). Each blob is read with `fileBytes(…, { maxBytes })` and decoded through `decodePngBounded`, whose pixel limit is the step's remaining `maxTotalPixels` budget; pairs run one at a time with a yield between them. Over `maxSnapshots`, an unreadable merge base, an absent or oversized blob, a decoder refusal and an exhausted budget each record as `unmeasured` with a reason. The merge decision is unchanged.
