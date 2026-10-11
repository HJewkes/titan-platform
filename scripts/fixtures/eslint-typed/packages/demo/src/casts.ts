export function narrowsUnknown(value: unknown): string {
  return value as string;
}

export function restatesItsType(value: string): string {
  return value as string;
}

export function checksAnArray(value: string[]): number {
  return value ? value.length : 0;
}

export const widensALiteral = "draft" as string;
