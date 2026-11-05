import { z } from 'zod';

/** An RFC 6901 JSON Pointer: the empty string (the whole document) or `/`-prefixed reference tokens. */
export const jsonPointerSchema = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/, 'not a JSON Pointer (RFC 6901)');

/** The value the pointer names, or undefined when the document has none there. */
export function resolvePointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  let current = document;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}
