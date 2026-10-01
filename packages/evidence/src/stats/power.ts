export interface DetectableEffectOptions {
  n: number;
  sd: number;
  alpha?: number;
  power?: number;
  sides?: 1 | 2;
}
export function minimumDetectableEffect(_o: DetectableEffectOptions): number {
  throw new Error("stub");
}
