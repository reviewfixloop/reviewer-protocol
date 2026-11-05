import { RE2JS } from 're2js';
import { z } from 'zod';

/**
 * A manifest's regular expressions run against vendor output the manifest's author does not
 * control, so they must match in linear time. RE2 guarantees that and has no backreferences
 * or lookaround, so compiling a pattern with it is the whole check.
 */
export const patternSchema = z
  .string()
  .min(1)
  .superRefine((source, context) => {
    try {
      RE2JS.compile(source);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: `not a linear-time regular expression: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

const compiled = new Map<string, RE2JS>();

function compile(source: string): RE2JS {
  let pattern = compiled.get(source);
  if (pattern === undefined) {
    pattern = RE2JS.compile(source);
    compiled.set(source, pattern);
  }
  return pattern;
}

export function patternMatches(source: string, text: string): boolean {
  return compile(source).matcher(text).find();
}

/** The first capture group of the first match, or the whole match when the pattern has no group. */
export function patternCapture(source: string, text: string): string | undefined {
  const matcher = compile(source).matcher(text);
  if (!matcher.find()) return undefined;
  return (matcher.groupCount() > 0 ? matcher.group(1) : matcher.group(0)) ?? undefined;
}

/**
 * The latest position in the text at which the pattern matches, or undefined when it never
 * matches. One match behind a greedy prefix finds it: repeating `find` would rescan the rest
 * of the text after every match, which is quadratic.
 */
export function patternLastMatchStart(source: string, text: string): number | undefined {
  const matcher = compile(`(?s:.*)(${source})`).matcher(text);
  return matcher.find() ? matcher.start(1) : undefined;
}
