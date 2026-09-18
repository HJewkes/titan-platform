// @ts-nocheck
// try/catch with specific error type checks
async function fetchUser(id: string) {
  try {
    const response = await fetch(`/api/users/${id}`);
    if (!response.ok) {
      throw new HttpError(response.status, "Failed to fetch user");
    }
    return await response.json();
  } catch (error) {
    if (error instanceof HttpError) {
      console.error(`HTTP ${error.status}: ${error.message}`);
    } else if (error instanceof TypeError) {
      console.error("Network error");
    }
    throw error;
  }
}

// try/catch with generic catch (non-specific)
function parseConfig(raw: string) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Custom error class
class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

class ValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

// Result type pattern
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

function safeParse(input: string): Result<object> {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (e) {
    return { ok: false, error: e as Error };
  }
}

// Exhaustive switch with assertNever
type Shape = { kind: "circle"; radius: number } | { kind: "square"; side: number };

function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${x}`);
}

function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius ** 2;
    case "square":
      return shape.side ** 2;
    default:
      return assertNever(shape);
  }
}

// Non-exhaustive switch (no default)
function getLabel(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "inactive":
      return "Inactive";
  }
  return "Unknown";
}
