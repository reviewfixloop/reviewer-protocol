import { z } from 'zod';

/**
 * The protocol's major version. Optional fields and failure kinds are added without raising
 * it: every schema here ignores unknown fields and reads an unknown failure kind as `unknown`,
 * so an older host keeps accepting a newer reviewer.
 */
export const REVIEWER_PROTOCOL_VERSION = 1;

/**
 * Why a turn failed, classified by the host's vocabulary: few vendors classify their own
 * failures, and those that do disagree on the names. Timeouts, crashes and cancellations are
 * not kinds: the host observes them itself, since no vendor reports them reliably.
 */
export const FAILURE_KINDS = [
  'authentication',
  'quota',
  'rate_limit',
  'overloaded',
  'context_overflow',
  'max_output',
  'refusal',
  'model_not_found',
  'transport',
  'harness_error',
  'unknown',
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

// oxlint-disable-next-line unicorn/prefer-top-level-await -- zod's `catch` supplies a fallback value; it is no promise chain.
export const failureKindSchema = z.enum(FAILURE_KINDS).catch('unknown');

export const failureSchema = z.object({
  kind: failureKindSchema,
  message: z.string(),
  /** When the vendor says the request may be retried (epoch milliseconds). */
  retryAt: z.number().int().nonnegative().optional(),
});
export type Failure = z.infer<typeof failureSchema>;

export const sessionEventSchema = z.object({
  type: z.literal('session'),
  /** The harness's own session id: what a later turn passes to continue this session. */
  id: z.string().min(1),
  harness: z.object({ name: z.string().min(1), version: z.string().optional() }).optional(),
  model: z.string().optional(),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const PROGRESS_KINDS = ['message', 'thought', 'tool_start', 'tool_end', 'model_call'] as const;
export type ProgressKind = (typeof PROGRESS_KINDS)[number];

export const progressEventSchema = z.object({
  type: z.literal('progress'),
  kind: z.enum(PROGRESS_KINDS),
  text: z.string().optional(),
});
export type ProgressEvent = z.infer<typeof progressEventSchema>;

const tokenCountSchema = z.number().int().nonnegative();

/**
 * Tokens spent since the previous usage event, in the host's unified meaning: `input`
 * excludes cache reads and writes, `output` includes reasoning, and `reasoning` is the part
 * of `output` spent on reasoning. Tokens are authoritative; `costUsd` is a reference value,
 * since few harnesses report it and some estimate it.
 */
export const usageEventSchema = z.object({
  type: z.literal('usage'),
  /** Identifies this report within its session, so a report delivered twice counts once. */
  key: z.string().min(1),
  model: z.string().optional(),
  input: tokenCountSchema,
  output: tokenCountSchema,
  cacheRead: tokenCountSchema,
  cacheWrite: tokenCountSchema.optional(),
  reasoning: tokenCountSchema.optional(),
  costUsd: z.number().nonnegative().optional(),
  /**
   * The model calls since the previous usage event that each upstream provider served, by the name the endpoint
   * gave it: a gateway such as OpenRouter routes the same model to several providers, which may serve it differently.
   * Absent when no endpoint named one.
   */
  servedBy: z.record(z.string().min(1), tokenCountSchema).optional(),
});
export type UsageEvent = z.infer<typeof usageEventSchema>;

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export const logEventSchema = z.object({
  type: z.literal('log'),
  level: z.enum(LOG_LEVELS),
  text: z.string(),
});
export type LogEvent = z.infer<typeof logEventSchema>;

export const turnEndEventSchema = z.object({
  type: z.literal('turn_end'),
  status: z.enum(['completed', 'failed']),
  /** The harness's own stop reason, kept for diagnosis. */
  stopReason: z.string().optional(),
  /** The final assistant text of the turn. */
  text: z.string().optional(),
  failure: failureSchema.optional(),
  /** False when some of the turn's usage is known to be unreported. */
  usageComplete: z.boolean(),
});
export type TurnEndEvent = z.infer<typeof turnEndEventSchema>;

export const reviewerEventSchema = z.discriminatedUnion('type', [
  sessionEventSchema,
  progressEventSchema,
  usageEventSchema,
  logEventSchema,
  turnEndEventSchema,
]);
export type ReviewerEvent = z.infer<typeof reviewerEventSchema>;
