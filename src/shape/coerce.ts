/**
 * Reading the router's JSON without trusting its shape.
 *
 * RCI answers are untyped and shift between firmware versions: a branch with
 * one record comes back as a bare object, an empty one as `{}` or `[]`, and a
 * field that is a number on one release is a string on the next. Every reader
 * used to carry its own copy of these helpers, and the copies had drifted -
 * some treated an array as a record, some did not. This is the one definition.
 */
export type Row = Record<string, unknown>;

export function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as a record, or an empty one. An array is never a record. */
export function asRecord(value: unknown): Row {
  return isRecord(value) ? value : {};
}

/**
 * A config branch with one surviving record often comes back as a bare object
 * instead of a one-element array - the router unwraps it. Normalize both.
 */
export function asEntries(value: unknown): Row[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) return [value];
  return [];
}

export function str(source: Row, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

export function num(source: Row, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A finite number, or null. Accepts the numeric strings the router also sends. */
export function numOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function bool(source: Row, key: string): boolean {
  return source[key] === true;
}
