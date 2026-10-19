type Signoff = "correctness" | "adversary" | "owner";

interface SignoffFacts {
  /** The touches the changed files alone make, test files exempt; a kind adds none, so a security kind with no such path is not adversarial. */
  touches: readonly string[];
  /** Every changed path, a rename's old path included. */
  paths: readonly string[];
}

/** The one rule file decision 422(1) keeps with the owner: a diff touching it is never released on two MERGEs, whatever its class. */
export const OWNER_PACKET_FILES: readonly string[] = ["packages/authority/src/table.json"];

/** The guards our own agents try to get past (E1), where a bug is an exploit rather than a defect, so a second, adversarial reviewer earns its cost. */
const ADVERSARY_TOUCHES: readonly string[] = ["authority", "policy", "security"];

export const adversaryTouches = (touches: readonly string[]): string[] => ADVERSARY_TOUCHES.filter((touch) => touches.includes(touch));

/**
 * Review policy 458: one correctness sign-off by default. Size, dependency, migration and a security kind pick a stronger
 * correctness reviewer, not a second one. Only an adversarial path adds an adversary; the owner's rule file and rendered
 * output add the owner.
 */
export function requiredSignoffs({ touches, paths }: SignoffFacts): Signoff[] {
  const adversary = adversaryTouches(touches).length > 0;
  const owner = touches.includes("visual") || paths.some((path) => OWNER_PACKET_FILES.includes(path));
  return ["correctness", ...(adversary ? (["adversary"] as const) : []), ...(owner ? (["owner"] as const) : [])];
}
