/** The part of a wrapper's option spec that decides how a short cluster splits. */
interface ClusterSpec {
  /** Options, with their dash, that take a value. */
  values?: string[];
  /** Short options, without the dash, whose value is optional and only ever attached. */
  optional?: string[];
  /** Whether a digit is an option of this wrapper, as `-0` is for `xargs` and `env`. */
  digits?: boolean;
}

interface Cluster {
  /** The options read before the one that ends the cluster, in order. */
  flags: string[];
  /** The first option that takes a value; `text` is the rest of the word, empty when the value is the next word. */
  end: { option: string; text: string; optional: boolean } | null;
}

/**
 * Splits a short option cluster the way getopt does: each character is an option, and the first one that takes a value
 * ends the cluster, the rest of the word being its attached value. Null when `word` is no cluster this wrapper reads.
 */
export function splitCluster(word: string, spec: ClusterSpec = {}): Cluster | null {
  if (!word.startsWith("-") || word.startsWith("--")) return null;
  const { values = [], optional = [], digits } = spec;
  const flags: string[] = [];
  for (let k = 1; k < word.length; k++) {
    const option = word[k] as string;
    const isOptional = optional.includes(option);
    if (isOptional || values.includes(`-${option}`)) return { flags, end: { option, text: word.slice(k + 1), optional: isOptional } };
    if (!(digits ? /[A-Za-z0-9]/ : /[A-Za-z]/).test(option)) return null;
    flags.push(option);
  }
  return { flags, end: null };
}

/** Whether option word `word` takes the next word as its value: `-I`, or a cluster ending in one, `-tI`, `-0n`. */
export function takesNextWord(word: string, spec: ClusterSpec = {}): boolean {
  const cluster = splitCluster(word, spec);
  if (!cluster) return (spec.values ?? []).includes(word);
  return cluster.end !== null && !cluster.end.optional && cluster.end.text === "";
}
