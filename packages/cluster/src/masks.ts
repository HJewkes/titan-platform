import genericMaskConfig from "./masks/generic.js";

/**
 * A typed-mask rule: `pattern`/`flags` build a `RegExp`; every match becomes
 * `<name>` in the masked signature, and the first match's text is recorded
 * under `extractedParams[name]`.
 */
export interface MaskRule {
  name: string;
  pattern: string;
  flags: string;
}

export interface MaskResult {
  maskedSignature: string;
  extractedParams: Record<string, string>;
}

/** Frozen mask configs keyed by partition; unregistered partitions fall back to `generic`. */
export type MaskConfigs = Record<string, MaskRule[]>;

export const DEFAULT_MASK_CONFIGS: MaskConfigs = { generic: genericMaskConfig };

/**
 * Apply the partition's mask rules to a signature line in rule order, so an
 * earlier rule's placeholder (`<UUID>`) is never re-matched by a later, looser
 * rule (`<NUM>`).
 */
export function applyMasks(partition: string, signatureLine: string, configs: MaskConfigs = DEFAULT_MASK_CONFIGS): MaskResult {
  const rules = configs[partition] ?? configs.generic ?? [];
  const extractedParams: Record<string, string> = {};

  let masked = signatureLine;
  for (const rule of rules) {
    const regex = new RegExp(rule.pattern, rule.flags);
    masked = masked.replace(regex, (match) => {
      if (!(rule.name in extractedParams)) extractedParams[rule.name] = match;
      return `<${rule.name}>`;
    });
  }
  return { maskedSignature: masked, extractedParams };
}
