import { z } from 'zod';

import { failureSchema, usageEventSchema } from './events.ts';
import { MANIFEST_ROLES } from './manifest.ts';

/**
 * The Reviewer Protocol's extension of ACP (Agent Client Protocol) v1. ACP carries custom
 * data only under `_meta`, so everything the protocol adds travels under this key: the
 * agent advertises it in `initialize`, the host sends the session's conditions with
 * `session/new`, and the agent reports each turn's usage and failure with its
 * `session/prompt` response.
 */
export const ACP_META_KEY = 'reviewer-protocol/v1';

/** In `agentCapabilities._meta` of the `initialize` response: the agent speaks the extension. */
export const acpCapabilityMetaSchema = z.object({ version: z.literal(1) });
export type AcpCapabilityMeta = z.infer<typeof acpCapabilityMetaSchema>;

/** In `_meta` of the `session/new` request: what ACP itself has no field for. */
export const acpSessionMetaSchema = z.object({
  role: z.enum(MANIFEST_ROLES),
  /** The revision under review: a commit SHA. */
  revision: z.string().min(1),
  /** Minutes until the host cancels the session's turn. */
  deadlineMinutes: z.number().positive().optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});
export type AcpSessionMeta = z.infer<typeof acpSessionMetaSchema>;

/**
 * In `_meta` of the `session/prompt` response: the turn's usage in the protocol's unified
 * meaning (see usageEventSchema) and, for a turn the agent could not finish, its failure.
 */
export const acpTurnMetaSchema = z.object({
  usage: usageEventSchema.omit({ type: true, key: true }).optional(),
  usageComplete: z.boolean().optional(),
  failure: failureSchema.optional(),
});
export type AcpTurnMeta = z.infer<typeof acpTurnMetaSchema>;

/** The extension's part of an ACP `_meta` object, validated by `schema`; undefined when absent or malformed. */
export function readAcpMeta<Schema extends z.ZodType>(meta: unknown, schema: Schema): z.infer<Schema> | undefined {
  if (meta === null || typeof meta !== 'object') return undefined;
  const result = schema.safeParse((meta as Record<string, unknown>)[ACP_META_KEY]);
  return result.success ? result.data : undefined;
}

/** An ACP `_meta` object carrying the extension's part. */
export function acpMeta<Value>(value: Value): Record<typeof ACP_META_KEY, Value> {
  return { [ACP_META_KEY]: value };
}
