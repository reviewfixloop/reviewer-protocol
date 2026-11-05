import type { FailureKind, ReviewerEvent, TurnEndEvent, UsageEvent } from './events.ts';
import { FAILURE_KINDS } from './events.ts';
import { resolvePointer } from './jsonPointer.ts';
import type { EmitSpec, Manifest, MappingRule, Scalar, UsageSemantics, ValueSpec } from './manifest.ts';
import { patternLastMatchStart } from './pattern.ts';

type JsonlTransport = Extract<Manifest['transport'], { type: 'jsonl' }>;

export interface ProcessMapper {
  /**
   * The events one line of the process's standard output maps to; a line that is not a JSON
   * object maps to none. With a manifest that names a usage file, a `turn_end` is withheld
   * until `mapUsageFile`, so that the turn's usage precedes it.
   */
  mapLine(line: string): ReviewerEvent[];
  /**
   * Called once after the process exited, with the text of the manifest's usage file or
   * nothing when the file is missing: the usage event it maps to, then the withheld
   * `turn_end`, whose usage is incomplete when the file gave none (it is missing, is not a
   * JSON object, or holds none of the declared counts). Empty for a manifest that names no
   * usage file.
   */
  mapUsageFile(text?: string): ReviewerEvent[];
  /**
   * Whether the process's usage is unreported: it has produced no usage event (the manifest
   * maps none, the harness died first, the usage file is missing), or one of its reports held
   * none of the declared counts. It is final once the process has exited and the usage file
   * is mapped, and the host decides with it then: a turn's usage is complete when its
   * `turn_end` says so and this is false. A `turn_end` mapped from a line cannot know what
   * follows it, so it carries only what is already settled (a report without counts so far,
   * a manifest without any usage source).
   */
  usageUnreported(): boolean;
}

export interface SessionMapper {
  /**
   * The mapper of one process of the session. `stderrTail` supplies the end of that process's
   * standard error when a failed turn needs its failure classified. `continuesSession` says
   * whether the process was launched to continue the harness's session (with `resumeArgs` and
   * a session id): one that starts a new session counts its running usage total from zero.
   * It defaults to whether the manifest can continue sessions at all.
   */
  forProcess(stderrTail?: () => string, continuesSession?: boolean): ProcessMapper;
}

interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

type UsageEmit = Extract<EmitSpec, { type: 'usage' }>;
type SessionEmit = Extract<EmitSpec, { type: 'session' }>;
type ProgressEmit = Extract<EmitSpec, { type: 'progress' }>;
type TurnEndEmit = Extract<EmitSpec, { type: 'turn_end' }>;
type MappedManifest = Pick<Manifest, 'id' | 'failures'> & { transport: JsonlTransport };
type TextOf = (spec: ValueSpec | undefined) => string | undefined;

/**
 * Maps the output of one harness's processes by the manifest's rules, for one job of the host.
 * It holds the running usage total of the session being mapped, which a harness that reports
 * cumulatively carries across the processes that continue that session, and restarts it for a
 * process the host says starts a new session (see `forProcess`).
 */
export function createSessionMapper(manifest: MappedManifest): SessionMapper {
  const usage = new SessionUsage(manifest.transport.usage);
  return {
    forProcess(stderrTail = () => '', continuesSession = manifest.transport.resumeArgs !== undefined) {
      if (!continuesSession) usage.restartTotals();
      return new JsonlProcessMapper(manifest, usage, stderrTail);
    },
  };
}

class JsonlProcessMapper implements ProcessMapper {
  private readonly hasUsageSource: boolean;
  private readonly seenProgress = new Set<string>();
  private withheldTurnEnd: TurnEndEvent | undefined;
  private sessionId: string | undefined;
  private usageEvents = 0;
  private reportWithoutCounts = false;

  constructor(
    private readonly manifest: MappedManifest,
    private readonly usage: SessionUsage,
    private readonly stderrTail: () => string
  ) {
    const { events: rules, usageFile } = manifest.transport;
    this.hasUsageSource = usageFile !== undefined || rules.some((rule) => rule.emit.type === 'usage');
  }

  mapLine(rawLine: string): ReviewerEvent[] {
    const line = parseObject(rawLine);
    if (line === undefined) return [];
    const events = this.manifest.transport.events
      .filter((rule) => ruleApplies(rule, line))
      .flatMap((rule) => itemsOf(rule, line).flatMap((item) => this.toEvent(rule.emit, line, item) ?? []));
    // Applied after the line's rules: a usage rule may follow the rule that ends the turn.
    return events.flatMap((event) => (event.type === 'turn_end' ? this.settleTurnEnd(event) : [event]));
  }

  mapUsageFile(text?: string): ReviewerEvent[] {
    const { usageFile } = this.manifest.transport;
    if (usageFile === undefined) return [];
    const document = text === undefined ? undefined : parseObject(text);
    const usage = this.countUsage(this.usage.toEvent(usageFile.emit, document, undefined));
    const events: ReviewerEvent[] = usage === undefined ? [] : [usage];
    if (this.withheldTurnEnd !== undefined) {
      events.push({
        ...this.withheldTurnEnd,
        usageComplete: this.withheldTurnEnd.usageComplete && !this.usageUnreported(),
      });
      this.withheldTurnEnd = undefined;
    }
    return events;
  }

  usageUnreported(): boolean {
    return this.usageEvents === 0 || this.reportWithoutCounts;
  }

  private settleTurnEnd(event: TurnEndEvent): ReviewerEvent[] {
    if (this.manifest.transport.usageFile !== undefined) {
      this.withheldTurnEnd = event;
      return [];
    }
    return [this.reportWithoutCounts || !this.hasUsageSource ? { ...event, usageComplete: false } : event];
  }

  private countUsage(event: UsageEvent | undefined): UsageEvent | undefined {
    if (event === undefined) this.reportWithoutCounts = true;
    else this.usageEvents += 1;
    return event;
  }

  private toEvent(emit: EmitSpec, line: unknown, item: unknown): ReviewerEvent | undefined {
    const text: TextOf = (spec) => textOf(resolveValue(spec, line, item));
    switch (emit.type) {
      case 'session': {
        return this.toSessionEvent(emit, text);
      }
      case 'progress': {
        return this.toProgressEvent(emit, text);
      }
      case 'usage': {
        return this.countUsage(this.usage.toEvent(emit, line, item));
      }
      case 'log': {
        const body = text(emit.text);
        return body === undefined ? undefined : { type: 'log', level: emit.level, text: body };
      }
      case 'turn_end': {
        return this.toTurnEndEvent(emit, text);
      }
    }
  }

  private toSessionEvent(emit: SessionEmit, text: TextOf): ReviewerEvent | undefined {
    const id = text(emit.id);
    // Some harnesses name the session on every step.
    if (id === undefined || id === '' || id === this.sessionId) return undefined;
    this.sessionId = id;
    const model = text(emit.model);
    const version = text(emit.harnessVersion);
    return {
      type: 'session',
      id,
      ...(model === undefined ? {} : { model }),
      ...(version === undefined ? {} : { harness: { name: this.manifest.id, version } }),
    };
  }

  private toProgressEvent(emit: ProgressEmit, text: TextOf): ReviewerEvent | undefined {
    const body = text(emit.text);
    // A response that only calls tools carries an empty message.
    if (body === '' && (emit.kind === 'message' || emit.kind === 'thought')) return undefined;
    const key = text(emit.key);
    if (key !== undefined) {
      const seenKey = `${emit.kind}\0${key}`;
      if (this.seenProgress.has(seenKey)) return undefined;
      this.seenProgress.add(seenKey);
    }
    return { type: 'progress', kind: emit.kind, ...(body === undefined ? {} : { text: body }) };
  }

  private toTurnEndEvent(emit: TurnEndEmit, text: TextOf): TurnEndEvent | undefined {
    const status = text(emit.status);
    if (status !== 'completed' && status !== 'failed') return undefined;
    const stopReason = text(emit.stopReason);
    const finalText = text(emit.text);
    const base = {
      type: 'turn_end' as const,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(finalText === undefined ? {} : { text: finalText }),
      usageComplete: emit.usageComplete ?? true,
    };
    if (status === 'completed') return { ...base, status };
    const message = text(emit.failureMessage) ?? finalText ?? stopReason ?? 'the harness reported a failed turn';
    const declared = text(emit.failureKind);
    const kind = (FAILURE_KINDS as readonly string[]).includes(declared ?? '')
      ? (declared as FailureKind)
      : classifyFailure(this.manifest.failures, message, this.stderrTail());
    return { ...base, status, failure: { kind, message } };
  }
}

/** The running usage total of one session, carried across the processes that continue it. */
class SessionUsage {
  private totals: TokenCounts | undefined;
  private reports = 0;

  constructor(private readonly semantics: UsageSemantics) {}

  restartTotals(): void {
    this.totals = undefined;
  }

  /**
   * The usage event of one report, or undefined when none of the declared counts resolves to
   * a number (a renamed field): that report is unreported usage, not zero tokens.
   */
  toEvent(emit: UsageEmit, line: unknown, item: unknown): UsageEvent | undefined {
    const specs = [emit.input, emit.output, emit.cacheRead, emit.cacheWrite, emit.reasoning];
    if (!specs.some((spec) => typeof resolveValue(spec, line, item) === 'number')) return undefined;
    this.reports += 1;
    const counts = this.nextCounts(emit, line, item);
    const key = resolveValue(emit.key, line, item);
    const model = resolveValue(emit.model, line, item);
    const costUsd = resolveValue(emit.costUsd, line, item);
    return {
      type: 'usage',
      key: typeof key === 'number' || (typeof key === 'string' && key !== '') ? String(key) : `report-${this.reports}`,
      ...(typeof model === 'string' ? { model } : {}),
      input: counts.input,
      output: counts.output,
      cacheRead: counts.cacheRead,
      ...(emit.cacheWrite === undefined ? {} : { cacheWrite: counts.cacheWrite }),
      ...(emit.reasoning === undefined ? {} : { reasoning: counts.reasoning }),
      ...(typeof costUsd === 'number' && costUsd >= 0 ? { costUsd } : {}),
    };
  }

  private nextCounts(emit: UsageEmit, line: unknown, item: unknown): TokenCounts {
    const cumulative = this.semantics.mode === 'cumulative';
    const previous = cumulative ? this.totals : undefined;
    const count = (spec: ValueSpec | undefined, name: keyof TokenCounts): number =>
      reportedCount(resolveValue(spec, line, item), previous?.[name]);
    const reported: TokenCounts = {
      input: count(emit.input, 'input'),
      output: count(emit.output, 'output'),
      cacheRead: count(emit.cacheRead, 'cacheRead'),
      cacheWrite: count(emit.cacheWrite, 'cacheWrite'),
      reasoning: count(emit.reasoning, 'reasoning'),
    };
    // Normalized before the subtraction: a running total keeps the harness's own meaning.
    const counts = normalizeCounts(reported, this.semantics);
    if (!cumulative) return counts;
    this.totals = reported;
    return previous === undefined ? counts : subtractCounts(counts, normalizeCounts(previous, this.semantics));
  }
}

/**
 * A count the report omits is unreported: a running total keeps its last value, so that the
 * count's next report is not differenced from zero.
 */
function reportedCount(value: unknown, previous: number | undefined): number {
  if (typeof value !== 'number') return previous ?? 0;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? undefined : JSON.stringify(value);
}

/**
 * The kind of a failure the harness did not classify: every pattern is tried on the failure
 * message followed by the end of standard error, and the match that starts latest decides
 * (the last thing reported is the failure that ended the turn); `unknown` when none matches.
 */
export function classifyFailure(failures: Manifest['failures'], message: string, stderrTail: string): FailureKind {
  const text = `${message}\n${stderrTail}`;
  let best: { start: number; kind: FailureKind } | undefined;
  for (const { pattern, kind } of failures ?? []) {
    const start = patternLastMatchStart(pattern, text);
    if (start !== undefined && (best === undefined || start >= best.start)) best = { start, kind };
  }
  return best?.kind ?? 'unknown';
}

function parseObject(rawLine: string): unknown {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function ruleApplies(rule: MappingRule, line: unknown): boolean {
  return matches(rule.match, line) && (rule.unless === undefined || !matches(rule.unless, line));
}

function itemsOf(rule: MappingRule, line: unknown): unknown[] {
  if (rule.each === undefined) return [undefined];
  const list = resolvePointer(line, rule.each);
  if (!Array.isArray(list)) return [];
  return list.filter((item: unknown) => matches(rule.itemMatch, item));
}

function matches(match: MappingRule['match'], document: unknown): boolean {
  for (const [pointer, expected] of Object.entries(match ?? {})) {
    const actual = resolvePointer(document, pointer);
    const allowed: readonly Scalar[] = Array.isArray(expected) ? expected : [expected as Scalar];
    if (!allowed.includes(actual as Scalar)) return false;
  }
  return true;
}

function resolveValue(spec: ValueSpec | undefined, line: unknown, item: unknown): unknown {
  if (spec === undefined) return undefined;
  if (spec === null || typeof spec !== 'object') return spec;
  const value = 'from' in spec ? resolvePointer(line, spec.from) : resolvePointer(item, spec.fromItem);
  const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  if (spec.map !== undefined && scalar && Object.hasOwn(spec.map, String(value))) return spec.map[String(value)];
  // The default replaces what a map does not list (an object or array included) and an absent
  // value, which JSON's null is too.
  const unlisted = spec.map !== undefined || value === undefined || value === null;
  return unlisted && spec.default !== undefined ? spec.default : value;
}

function subtractCounts(current: TokenCounts, previous: TokenCounts): TokenCounts {
  return {
    input: difference(current.input, previous.input),
    output: difference(current.output, previous.output),
    cacheRead: difference(current.cacheRead, previous.cacheRead),
    cacheWrite: difference(current.cacheWrite, previous.cacheWrite),
    reasoning: difference(current.reasoning, previous.reasoning),
  };
}

function difference(now: number, before: number): number {
  return Math.max(0, now - before);
}

function normalizeCounts(counts: TokenCounts, semantics: UsageSemantics): TokenCounts {
  let { input, output } = counts;
  if (semantics.inputIncludesCacheRead === true) input -= counts.cacheRead;
  if (semantics.inputIncludesCacheWrite === true) input -= counts.cacheWrite;
  if (semantics.outputIncludesReasoning === false) output += counts.reasoning;
  return { ...counts, input: Math.max(0, input), output };
}
