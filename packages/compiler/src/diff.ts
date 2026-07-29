import type { SpecChange } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function diffValues(
  before: unknown,
  after: unknown,
  path = "",
): SpecChange[] {
  if (Object.is(before, after)) return [];

  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    return Array.from({ length }, (_, index) =>
      diffValues(before[index], after[index], `${path}/${index}`),
    ).flat();
  }

  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys]
      .sort()
      .flatMap((key) =>
        diffValues(before[key], after[key], `${path}/${key}`),
      );
  }

  return [{ path: path || "/", before, after }];
}
