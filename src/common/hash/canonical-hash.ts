import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization: object keys are sorted recursively so that
 * `{a:1,b:2}` and `{b:2,a:1}` hash identically. This is what makes the
 * idempotency request_hash a stable identity of *payload content* rather than of
 * incidental key ordering.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** SHA-256 over the canonical form of a payload. */
export function hashPayload(payload: unknown): string {
  return sha256Hex(JSON.stringify(canonicalize(payload)));
}
