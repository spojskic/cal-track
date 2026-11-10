const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for a canonical `8-4-4-4-12` UUID. Route ids are checked with it BEFORE querying, because Postgres rejects
 * anything else with "invalid input syntax for type uuid", which would otherwise reach the user as a raw database error.
 */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
