/**
 * Lightweight runtime validation helpers for DB row casts.
 * The codebase uses `as SomeRow[]` after `db.prepare().all()` —
 * these helpers guard against schema drift or corrupt data.
 */

/**
 * Returns true if `row` is a non-null object containing all specified fields.
 * Use before unsafe casts or JSON.parse on DB row fields.
 */
export function hasFields(row: unknown, fields: string[]): boolean {
  return (
    typeof row === 'object' &&
    row !== null &&
    fields.every((f) => f in (row as Record<string, unknown>))
  );
}
