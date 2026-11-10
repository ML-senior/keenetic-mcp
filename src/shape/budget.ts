export interface CappedList<T> {
  items: T[];
  shown: number;
  total: number;
  truncated: boolean;
  note?: string;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * Trims a list to the item limit, then shrinks further until it fits the byte
 * ceiling. At least one item is always returned, even if that single item is
 * over budget - returning nothing would be less useful than returning too much.
 */
export function capList<T>(items: readonly T[], limit: number, maxBytes: number): CappedList<T> {
  const total = items.length;
  let kept = items.slice(0, Math.max(0, limit));

  while (kept.length > 1 && byteLength(kept) > maxBytes) {
    // Halve rather than step down one at a time: a 455-row NAT table would
    // otherwise re-serialise hundreds of times.
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
  }

  const truncated = kept.length < total || (kept.length > 0 && byteLength(kept) > maxBytes);

  const result: CappedList<T> = {
    items: kept,
    shown: kept.length,
    total,
    truncated
  };
  if (kept.length < total) {
    result.note =
      `Showing ${kept.length} of ${total} entries. Narrow the query with the ` +
      `filter, sort or limit parameters to see the rest.`;
  }
  return result;
}

/**
 * Cuts text to a byte ceiling, never through the middle of a character.
 *
 * The ceiling is in bytes because that is what the operator configured, and
 * the cut used to be made in characters. For ASCII the two agree; for a
 * network whose devices are named in Cyrillic every character is two bytes, so
 * a "25 KB" response went out at up to twice that.
 */
export function capText(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;

  let end = Math.max(0, maxBytes);
  // A UTF-8 continuation byte is 10xxxxxx; back up to the start of the character.
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  const head = bytes.subarray(0, end).toString('utf8');
  return (
    `${head}\n\n[truncated: ${String(bytes.length)} bytes total, showing the first ` +
    `${String(end)}. Narrow the request to see the rest.]`
  );
}
