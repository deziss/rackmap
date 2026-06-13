/** Keyset pagination on integer `id` column. */
export function buildCursorWhere(cursor?: number) {
  return cursor ? { id: { lt: cursor } } : {};
}

export function getNextCursor<T extends { id: number }>(
  items: T[],
  limit: number,
): number | null {
  if (items.length < limit) return null;
  const last = items.at(-1);
  return last ? last.id : null;
}
