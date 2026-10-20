/** A handle a step body may use, plus the secret strings that must never leave it. */
export interface WorkflowCapability<T = unknown> {
  handle: T;
  secrets: readonly string[];
}

/** Names the step and the place; never the secret, so the refusal itself cannot leak it. */
export class CapabilityLeakError extends Error {
  constructor(readonly where: string) {
    super(`capability secret refused in ${where}`);
    this.name = "CapabilityLeakError";
  }
}

const REDACTED = "[redacted]";

/** Holds the capabilities of one runtime and checks every value bound for the record against their secrets. */
export class CapabilityVault {
  private readonly entries = new Map<string, WorkflowCapability>();
  private readonly needles: string[];

  constructor(capabilities: Readonly<Record<string, WorkflowCapability>>) {
    for (const [name, entry] of Object.entries(capabilities)) {
      if (entry.secrets.some((secret) => typeof secret !== "string" || secret === "")) {
        throw new TypeError(`capability ${name} must list non-empty string secrets`);
      }
      this.entries.set(name, entry);
    }
    this.needles = [...new Set([...this.entries.values()].flatMap((entry) => entry.secrets.flatMap(forms)))];
  }

  get(name: string): unknown {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`unknown capability: ${name}`);
    return entry.handle;
  }

  /** Throws `CapabilityLeakError` when a string anywhere in `value`, or a key, holds a secret. */
  refuse(value: unknown, where: string): void {
    if (this.needles.length > 0 && this.holds(value, new Set())) throw new CapabilityLeakError(where);
  }

  private holds(value: unknown, seen: Set<object>): boolean {
    if (typeof value === "string") return this.needles.some((needle) => value.includes(needle));
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    return Object.entries(value).some(([key, inner]) => this.holds(key, seen) || this.holds(inner, seen));
  }

  redact(text: string): string {
    return this.needles.reduce((acc, needle) => acc.split(needle).join(REDACTED), text);
  }
}

function forms(secret: string): string[] {
  const escaped = JSON.stringify(secret).slice(1, -1);
  return escaped === secret ? [secret] : [secret, escaped];
}

export const NO_CAPABILITIES = new CapabilityVault({});

/**
 * A seed's data lands in the run's params before the result is recorded, so its result is refused here; the context
 * also refuses every result as it is recorded. A throw that holds a secret becomes a refusal naming only the step.
 */
export async function seedBody<T>(vault: CapabilityVault | undefined, stepId: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    vault?.refuse(result, `${stepId} result`);
    return result;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (error instanceof CapabilityLeakError || !vault || vault.redact(text) === text) throw error;
    throw new CapabilityLeakError(`${stepId} error`);
  }
}
