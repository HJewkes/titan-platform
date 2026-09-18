function add(a: number, b: number): number {
  return a + b;
}

function processData(input: string[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  let count = 0;

  for (const item of input) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);

    const trimmed = item.trim();
    if (trimmed.length === 0) {
      errors.push("empty");
      continue;
    }

    const upper = trimmed.toUpperCase();
    results.push(upper);
    count++;
  }

  if (errors.length > 0) {
    console.warn(errors);
  }

  return results;
}

function deeplyNested(data: unknown): string {
  if (data) {
    if (typeof data === "object") {
      if (Array.isArray(data)) {
        for (const item of data) {
          if (typeof item === "string") {
            return item;
          }
        }
      }
    }
  }
  return "";
}

function classify(value: number): string {
  if (value < 0) {
    return "negative";
  } else if (value === 0) {
    return "zero";
  } else if (value < 10) {
    return "small";
  } else if (value < 100) {
    return "medium";
  } else {
    return "large";
  }
}
