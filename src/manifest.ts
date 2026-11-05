import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { z } from 'zod';

import { canonicalJson, sha256Hex } from './canonicalJson.ts';
import { FAILURE_KINDS, LOG_LEVELS, PROGRESS_KINDS } from './events.ts';
import { jsonPointerSchema } from './jsonPointer.ts';
import { patternSchema } from './pattern.ts';
import { argTemplateSchema, templateStringSchema } from './template.ts';

/**
 * The manifest schema's major version. The schema rejects unknown keys, so adding a key
 * raises it; a host refuses a manifest newer than itself and asks to be updated.
 */
export const MANIFEST_SCHEMA_VERSION = 1;

export const MANIFEST_ROLES = ['reviewer', 'resolver'] as const;
export type ManifestRole = (typeof MANIFEST_ROLES)[number];

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof scalarSchema>;

/**
 * Where a mapped event's field comes from: a literal, or a JSON Pointer into the output line
 * (`from`) or into the element `each` iterates (`fromItem`), optionally translated through
 * `map` (a value `map` does not list becomes `default`, or stays itself without one). An
 * absent or null value becomes `default` too.
 */
export const valueSpecSchema = z.union([
  scalarSchema,
  z.strictObject({
    from: jsonPointerSchema,
    map: z.record(z.string(), scalarSchema).optional(),
    default: scalarSchema.optional(),
  }),
  z.strictObject({
    fromItem: jsonPointerSchema,
    map: z.record(z.string(), scalarSchema).optional(),
    default: scalarSchema.optional(),
  }),
]);
export type ValueSpec = z.infer<typeof valueSpecSchema>;

const matchSchema = z.record(jsonPointerSchema, z.union([scalarSchema, z.array(scalarSchema).min(1)]));

const usageEmitSchema = z.strictObject({
  type: z.literal('usage'),
  /** Defaults to the report's position among the session's reports. */
  key: valueSpecSchema.optional(),
  model: valueSpecSchema.optional(),
  input: valueSpecSchema.optional(),
  output: valueSpecSchema.optional(),
  cacheRead: valueSpecSchema.optional(),
  cacheWrite: valueSpecSchema.optional(),
  reasoning: valueSpecSchema.optional(),
  costUsd: valueSpecSchema.optional(),
});

const emitSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session'),
    id: valueSpecSchema,
    model: valueSpecSchema.optional(),
    harnessVersion: valueSpecSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('progress'),
    kind: z.enum(PROGRESS_KINDS),
    text: valueSpecSchema.optional(),
    /**
     * Identifies what the line reports when the harness repeats it over several lines (one
     * model response split across lines): a kind's key emits its event once per process.
     */
    key: valueSpecSchema.optional(),
  }),
  usageEmitSchema,
  z.strictObject({
    type: z.literal('log'),
    level: z.enum(LOG_LEVELS),
    text: valueSpecSchema,
  }),
  z.strictObject({
    type: z.literal('turn_end'),
    /** Must resolve to `completed` or `failed`. */
    status: valueSpecSchema,
    stopReason: valueSpecSchema.optional(),
    text: valueSpecSchema.optional(),
    /** The failure's text, which the failure patterns classify unless `failureKind` resolves to a kind. */
    failureMessage: valueSpecSchema.optional(),
    failureKind: valueSpecSchema.optional(),
    usageComplete: z.boolean().optional(),
  }),
]);
export type EmitSpec = z.infer<typeof emitSchema>;

/**
 * One rule of the output mapping: a line that satisfies `match` (every pointer equals its
 * value, or one of its values) and does not satisfy `unless` emits one event, or with
 * `each` one event per element of the array it names that satisfies `itemMatch`.
 */
export const mappingRuleSchema = z
  .strictObject({
    match: matchSchema.optional(),
    unless: matchSchema.optional(),
    each: jsonPointerSchema.optional(),
    itemMatch: matchSchema.optional(),
    emit: emitSchema,
  })
  .superRefine((rule, context) => {
    if (rule.each !== undefined) return;
    if (rule.itemMatch !== undefined) context.addIssue({ code: 'custom', message: '"itemMatch" needs "each"' });
    if (readsItem(rule.emit)) context.addIssue({ code: 'custom', message: '"fromItem" needs "each"' });
  });
export type MappingRule = z.infer<typeof mappingRuleSchema>;

function readsItem(emit: EmitSpec): boolean {
  return Object.values(emit).some((value) => typeof value === 'object' && value !== null && 'fromItem' in value);
}

/**
 * How the harness reports token usage, so the host can bring it to the protocol's meaning
 * (`input` without cache reads and writes, `output` including reasoning) as deltas.
 */
export const usageSemanticsSchema = z.strictObject({
  /** `cumulative`: each report is the session's running total, which the host turns into deltas. */
  mode: z.enum(['delta', 'cumulative']),
  inputIncludesCacheRead: z.boolean().optional(),
  inputIncludesCacheWrite: z.boolean().optional(),
  /** False when the harness reports reasoning tokens apart from its output tokens. */
  outputIncludesReasoning: z.boolean().optional(),
});
export type UsageSemantics = z.infer<typeof usageSemanticsSchema>;

const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const environmentSchema = z
  .strictObject({
    set: z.record(envNameSchema, templateStringSchema).optional(),
    unset: z.array(envNameSchema).optional(),
  })
  .refine((env) => !(env.unset ?? []).some((name) => Object.hasOwn(env.set ?? {}, name)), {
    message: '"env" both sets and unsets a variable',
  });

/**
 * A path the host writes, removes or reads on the manifest's word, so it lies in the scratch
 * directory the host made for the harness. The host also refuses a rendered path that leaves
 * that directory, which a variable's value could make it do.
 */
const scratchPathSchema = templateStringSchema.refine(
  (path) => /^\{\{\s*scratchDir\s*\}\}\/./.test(path) && !path.split('/').includes('..'),
  { message: 'the path must start with "{{scratchDir}}/" and hold no ".." segment' }
);

/** A file the host writes before launching. */
const fileSchema = z.strictObject({ path: scratchPathSchema, content: templateStringSchema });

/** Arguments appended to a transport's `args` (and `resumeArgs`) on one operating system. */
const platformArgsSchema = z.strictObject({
  darwin: z.array(argTemplateSchema).optional(),
  linux: z.array(argTemplateSchema).optional(),
});

const jsonlTransportSchema = z.strictObject({
  type: z.literal('jsonl'),
  /** Arguments of the process that takes a session's first prompt. */
  args: z.array(argTemplateSchema),
  platformArgs: platformArgsSchema.optional(),
  /**
   * Arguments of a process that continues the session `{{sessionId}}` with another prompt.
   * A harness without them cannot continue a session: the host gives each later prompt, made
   * self-contained, to a new process started with `args`.
   */
  resumeArgs: z.array(argTemplateSchema).optional(),
  /** Text written to the process's standard input, which is then closed. */
  stdin: templateStringSchema.optional(),
  usage: usageSemanticsSchema,
  /**
   * A JSON file the harness writes its usage to instead of its output: the host reads it once
   * the process exits and maps it with `emit`, whose `from` pointers address the file. The
   * host removes it before each launch, so that what it reads is that process's own. The
   * turn's `turn_end` follows that usage event.
   */
  usageFile: z
    .strictObject({ path: scratchPathSchema, emit: usageEmitSchema })
    .refine((usageFile) => !readsItem(usageFile.emit), {
      message: '"fromItem" needs "each", which a usage file has not',
    })
    .optional(),
  /**
   * The output mapping. A process that ends without a mapped `turn_end` ends its turn by its
   * exit status: completed with its last message on zero, failed otherwise.
   */
  events: z.array(mappingRuleSchema).min(1),
});

const acpTransportSchema = z.strictObject({
  type: z.literal('acp'),
  /**
   * Arguments that start the harness's ACP (Agent Client Protocol v1) server on stdio. The
   * host selects the model and effort through the session's config options of the categories
   * `model` and `thought_level`.
   */
  args: z.array(argTemplateSchema),
  platformArgs: platformArgsSchema.optional(),
  /**
   * True for a harness that speaks the Reviewer Protocol extension itself
   * (`_meta["reviewer-protocol/v1"]`: it receives the revision, deadline, model and effort
   * there and reports usage and failures there). False for a vendor's stock ACP server, whose
   * per-turn usage the host reads from the prompt response when it carries one.
   */
  native: z.boolean(),
});

/** A host name the harness connects to, or `*.` and a domain for every host under it. */
const domainSchema = z.string().regex(/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/, {
  message: 'must be a host name or "*." and a domain',
});

/**
 * What the harness needs when the host runs it in a sandbox, which lets it read only the
 * working copy and the tools on PATH, write only the working copy and its scratch, see only
 * the variables the host passes, and connect only to the hosts allowed. A host refuses to
 * sandbox a harness whose manifest has no `sandbox`.
 */
const sandboxSchema = z.strictObject({
  /** Variables passed from the user's environment as they are: the ones the harness is configured with. */
  passEnv: z.array(envNameSchema).optional(),
  /**
   * Variables passed like `passEnv`, any one of which the harness signs in with in the sandbox,
   * where its saved login is out of reach: a host leaves the harness out of a sandboxed run while
   * none is set.
   */
  signInEnv: z.array(envNameSchema).min(1).optional(),
  /** Variables set in the sandbox alone, after `env`. */
  setEnv: z.record(envNameSchema, templateStringSchema).optional(),
  /** The hosts the harness reaches: its model's API and its sign-in. */
  domains: z.array(domainSchema).min(1),
});

/** What launching the harness as a resolver changes: it needs to edit, commit and push. */
const resolverOverrideSchema = z.strictObject({
  args: z.array(argTemplateSchema).optional(),
  resumeArgs: z.array(argTemplateSchema).optional(),
  env: environmentSchema.optional(),
});

export const manifestSchema = z
  .strictObject({
    schema: z.literal(MANIFEST_SCHEMA_VERSION),
    /** The harness's name within its registry namespace. */
    id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
    /** Shown to people only: it takes no part in the manifest's hash, so rewording it changes no identity. */
    display: z
      .strictObject({
        name: z.string().min(1),
        description: z.string().optional(),
        homepage: z.url().optional(),
        /** Where the vendor explains the usage limits a user should set their own limits by. */
        usageLimitsUrl: z.url().optional(),
      })
      .optional(),
    /** The executable's name, resolved on PATH: the user's own installation, which the host never ships. */
    command: z.string().regex(/^[A-Za-z0-9._-]+$/),
    /** How to read the installed harness's version. */
    version: z.strictObject({ args: z.array(z.string()), pattern: patternSchema }).optional(),
    models: z
      .strictObject({
        default: z.string().min(1).optional(),
        efforts: z.array(z.string().min(1)).optional(),
        defaultEffort: z.string().min(1).optional(),
      })
      .optional(),
    env: environmentSchema.optional(),
    files: z.array(fileSchema).optional(),
    transport: z.discriminatedUnion('type', [jsonlTransportSchema, acpTransportSchema]),
    /**
     * Classifies a failure the harness did not classify itself: each pattern is tried on the
     * failure message followed by the tail of standard error, and the match that starts
     * latest decides.
     */
    failures: z.array(z.strictObject({ pattern: patternSchema, kind: z.enum(FAILURE_KINDS) })).optional(),
    resolver: resolverOverrideSchema.optional(),
    sandbox: sandboxSchema.optional(),
  })
  .superRefine((manifest, context) => {
    const { resolver, transport } = manifest;
    const transportResumes = transport.type === 'jsonl' && transport.resumeArgs !== undefined;
    if (resolver?.resumeArgs !== undefined && !transportResumes) {
      context.addIssue({ code: 'custom', message: '"resolver.resumeArgs" needs the transport\'s "resumeArgs"' });
    }
    if (transportResumes && (resolver?.args === undefined) !== (resolver?.resumeArgs === undefined)) {
      context.addIssue({
        code: 'custom',
        message:
          '"resolver.args" and "resolver.resumeArgs" come together: one process of a resolver session would launch as a reviewer',
      });
    }
    if (transport.type === 'jsonl') checkUsageDeclarations(transport, context);
    const { models } = manifest;
    if (
      models?.defaultEffort !== undefined &&
      models.efforts !== undefined &&
      !models.efforts.includes(models.defaultEffort)
    ) {
      context.addIssue({ code: 'custom', message: '"defaultEffort" is not one of "efforts"' });
    }
  });
export type Manifest = z.infer<typeof manifestSchema>;

function checkUsageDeclarations(transport: z.infer<typeof jsonlTransportSchema>, context: z.RefinementCtx): void {
  const usageEmits = [
    ...transport.events.flatMap((rule) => (rule.emit.type === 'usage' ? [rule.emit] : [])),
    ...(transport.usageFile === undefined ? [] : [transport.usageFile.emit]),
  ];
  if (transport.usageFile !== undefined && usageEmits.length > 1) {
    context.addIssue({
      code: 'custom',
      message: '"usageFile" and a usage rule in "events" would report the same turn twice: declare one',
    });
  }
  // A declaration about a count the manifest never reads would silently change nothing.
  for (const [flag, declared, field] of [
    ['inputIncludesCacheRead', true, 'cacheRead'],
    ['inputIncludesCacheWrite', true, 'cacheWrite'],
    ['outputIncludesReasoning', false, 'reasoning'],
  ] as const) {
    if (transport.usage[flag] !== declared) continue;
    if (usageEmits.length > 0 && usageEmits.every((emit) => emit[field] !== undefined)) continue;
    context.addIssue({
      code: 'custom',
      message: `"${flag}": ${declared} has no effect unless the manifest maps usage and every usage emit maps "${field}"`,
    });
  }
}

/**
 * Parses a manifest file (JSON with comments). Throws naming every problem; a manifest of a
 * newer schema version is refused with advice to update the host.
 */
export function parseManifest(text: string): Manifest {
  const errors: ParseError[] = [];
  const document: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `the manifest is not valid JSONC: ${first === undefined ? 'unknown error' : printParseErrorCode(first.error)} at offset ${first?.offset ?? 0}`
    );
  }
  const declared = (document as { schema?: unknown } | null)?.schema;
  if (typeof declared === 'number' && declared > MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `the manifest uses schema ${declared}, newer than this host's ${MANIFEST_SCHEMA_VERSION}: update the host`
    );
  }
  const result = manifestSchema.safeParse(document);
  if (!result.success) throw new Error(`invalid manifest:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * The manifest's identity: SHA-256 of its validated content canonicalized by RFC 8785,
 * without `display`. Formatting, comments and display wording therefore never change it.
 */
export async function manifestHash(manifest: Manifest): Promise<string> {
  const { display: _display, ...identity } = manifest;
  return sha256Hex(canonicalJson(identity));
}
