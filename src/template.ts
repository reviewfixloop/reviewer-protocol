import { z } from 'zod';

/**
 * The variables a manifest template may read. A manifest holds no code: a template only
 * substitutes these, adds arguments when one has a value, expands a list, and applies the
 * `json` and `toml` filters.
 */
export const TEMPLATE_VARIABLES = [
  'prompt',
  'model',
  'effort',
  'sessionId',
  'deadlineMinutes',
  'logFile',
  'scratchDir',
  'tmpDir',
  'writableDirs',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export interface TemplateValues {
  prompt: string;
  model?: string;
  effort?: string;
  sessionId?: string;
  deadlineMinutes?: number;
  logFile?: string;
  scratchDir?: string;
  /** The temporary directory a sandboxed harness may write: its `TMPDIR`. */
  tmpDir?: string;
  writableDirs?: readonly string[];
}

/** The variables that hold a list: only `each` or a filter renders one. */
const LIST_VARIABLES = ['writableDirs'] as const satisfies readonly TemplateVariable[];
type ListVariable = (typeof LIST_VARIABLES)[number];

const FILTERS = ['json', 'toml'] as const;
type Filter = (typeof FILTERS)[number];

const PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*(?:\|\s*([A-Za-z]+)\s*)?\}\}/g;
// Only the opening pair: JSON text closes nested objects with `}}` and never opens one with `{{`.
const UNMATCHED_OPENING = /\{\{/;

/**
 * A string whose `{{var}}` and `{{var | filter}}` placeholders can be rendered: they name known
 * variables and filters, and a list variable goes through a filter.
 */
export const templateStringSchema = templateSchema(false);

const variableSchema = z.enum(TEMPLATE_VARIABLES);

export type ArgTemplate =
  | string
  | { when: TemplateVariable; args: ArgTemplate[] }
  | { each: ListVariable; args: ArgTemplate[] };

/** Argument templates; `{{item}}` is the element of the enclosing `each` and is rejected outside one. */
export const argTemplateSchema = argSchema(false);

function argSchema(insideEach: boolean): z.ZodType<ArgTemplate> {
  const schema: z.ZodType<ArgTemplate> = z.lazy(() =>
    z.union([
      templateSchema(insideEach),
      z.strictObject({ when: variableSchema, args: z.array(schema).min(1) }),
      z.strictObject({ each: z.enum(LIST_VARIABLES), args: z.array(argSchema(true)).min(1) }),
    ])
  );
  return schema;
}

function templateSchema(allowItem: boolean): z.ZodType<string> {
  return z.string().superRefine((value, context) => {
    for (const problem of templateProblems(value, allowItem)) context.addIssue({ code: 'custom', message: problem });
  });
}

/**
 * Renders one template string. Throws when it reads a variable that has no value: an
 * argument that depends on an optional variable belongs under `when`.
 */
export function renderTemplate(template: string, values: TemplateValues, item?: string): string {
  return template.replaceAll(PLACEHOLDER, (_match, name: string, filter: string | undefined) => {
    const value = name === 'item' ? item : (values as unknown as Record<string, unknown>)[name];
    if (value === undefined) throw new Error(`the template reads "${name}", which has no value here`);
    return applyFilter(value, filter as Filter | undefined);
  });
}

/** Expands argument templates into the argument vector, in order. */
export function renderArgs(templates: readonly ArgTemplate[], values: TemplateValues, item?: string): string[] {
  return templates.flatMap((template) => {
    if (typeof template === 'string') return [renderTemplate(template, values, item)];
    if ('when' in template) {
      return hasValue(values[template.when]) ? renderArgs(template.args, values, item) : [];
    }
    const list = values[template.each];
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new Error(`"each" needs a list, and "${template.each}" is not one`);
    return (list as readonly string[]).flatMap((element) => renderArgs(template.args, values, element));
  });
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
}

function applyFilter(value: unknown, filter: Filter | undefined): string {
  if (filter === 'json') return JSON.stringify(value);
  if (filter === 'toml') return tomlValue(value);
  if (Array.isArray(value)) throw new Error('a list is rendered through "each" or a filter');
  return String(value);
}

// TOML basic strings share JSON's escapes for every character JSON.stringify escapes, and
// TOML arrays of strings and numbers are written as JSON writes them.
function tomlValue(value: unknown): string {
  return JSON.stringify(value);
}

function templateProblems(value: string, allowItem: boolean): string[] {
  const problems: string[] = [];
  for (const match of value.matchAll(PLACEHOLDER)) {
    const [, name, filter] = match;
    if (name === 'item') {
      if (!allowItem) problems.push('"{{item}}" has a value only inside "each"');
    } else if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name ?? '')) {
      problems.push(`unknown template variable "${name}"`);
    } else if (filter === undefined && (LIST_VARIABLES as readonly string[]).includes(name ?? '')) {
      problems.push(`the list "${name}" is rendered through "each" or a filter`);
    }
    if (filter !== undefined && !(FILTERS as readonly string[]).includes(filter)) {
      problems.push(`unknown template filter "${filter}"`);
    }
  }
  if (UNMATCHED_OPENING.test(value.replaceAll(PLACEHOLDER, ''))) problems.push('malformed template placeholder');
  return problems;
}
