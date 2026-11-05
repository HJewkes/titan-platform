export {
  DEFAULT_BURDEN_CONFIG,
  resolveConfig,
  type BurdenConfig,
  type ChangedFile,
  type FileStatus,
  type PackageJsonChange,
} from "./config.js";
export { classifyPath, pathClassifier, type PathClass } from "./path-class.js";
export { FOOTER_MARKER, hasContract, parseFooter, type Door, type Footer } from "./footer.js";
export {
  doorFacts,
  effectiveDoor,
  underDeclared,
  type ChangesetBump,
  type DoorFacts,
  type DoorInput,
  type OneWayFact,
  type OneWayFactKind,
} from "./door.js";
export {
  burdenFacts,
  burdenScore,
  MAX_BURDEN,
  scoreParts,
  unitOf,
  type BurdenFacts,
  type BurdenInput,
  type BurdenParts,
  type BurdenScore,
} from "./score.js";
