import type { StoryOrderKey } from "./types.js";

export function compareStoryOrder(a: StoryOrderKey, b: StoryOrderKey): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
