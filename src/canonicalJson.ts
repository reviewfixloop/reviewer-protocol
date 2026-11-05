/**
 * Serializes a JSON value by RFC 8785 (JSON Canonicalization Scheme): object members sorted
 * by their names' UTF-16 code units, no insignificant whitespace, and ECMAScript's number and
 * string serialization. `Array.prototype.sort` without a comparator and `JSON.stringify` are
 * exactly those orderings and serializations.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JSON has no non-finite numbers');
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error(`not a JSON value: ${typeof value}`);
    return text;
  }
  if (Array.isArray(value)) return `[${value.map((element) => canonicalJson(element)).join(',')}]`;
  const members = Object.keys(value)
    .toSorted()
    .flatMap((name) => {
      const member = (value as Record<string, unknown>)[name];
      return member === undefined ? [] : [`${JSON.stringify(name)}:${canonicalJson(member)}`];
    });
  return `{${members.join(',')}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
