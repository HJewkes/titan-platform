/** `shepherd.visualThreshold` for one repo; a type-only leaf, so services.ts can carry it. */
export interface VisualThreshold {
  mode: "off" | "shadow" | "on";
  maxChangedShare?: number;
  pixelTolerance?: number;
  snapshotPaths: string[];
  apiPaths: string[];
  tokenPaths: string[];
  harnessPaths: string[];
  maxSnapshots?: number;
  maxBytes?: number;
  maxPixels?: number;
  maxTotalPixels?: number;
}
