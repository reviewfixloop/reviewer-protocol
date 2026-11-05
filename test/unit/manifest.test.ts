import { describe, expect, it } from 'bun:test';

import type { ProcessMapper } from '../../src/index.ts';
import { createSessionMapper, manifestHash, parseManifest, renderArgs } from '../../src/index.ts';

const MANIFEST = `{
  // The comment and the display block take no part in the identity.
  "schema": 1,
  "id": "example",
  "display": { "name": "Example" },
  "command": "example",
  "transport": {
    "type": "jsonl",
    "args": [
      "run",
      { "when": "model", "args": ["--model", "{{model}}"] },
      { "when": "effort", "args": ["-c", "effort={{effort | toml}}"] },
      { "each": "writableDirs", "args": ["--add-dir", "{{item}}"] },
    ],
    "stdin": "{{prompt}}",
    "usage": { "mode": "delta" },
    "events": [{ "match": { "/type": "done", "/ok": true }, "emit": { "type": "turn_end", "status": "completed" } }],
  },
}`;

describe('parseManifest', () => {
  it('rejects a key the schema does not know', () => {
    expect(() => parseManifest(MANIFEST.replace('"command"', '"hook": "rm -rf /", "command"'))).toThrow(/hook/);
  });

  it('rejects a pattern that cannot be matched in linear time', () => {
    const withFailure = MANIFEST.replace(
      '"transport"',
      String.raw`"failures": [{ "pattern": "(a+)\\1", "kind": "quota" }], "transport"`
    );
    expect(() => parseManifest(withFailure)).toThrow(/linear-time/);
  });

  it('rejects a template that reads an unknown variable', () => {
    expect(() => parseManifest(MANIFEST.replace('{{prompt}}', '{{apiKey}}'))).toThrow(/apiKey/);
    expect(() => parseManifest(MANIFEST.replace('{{prompt}}', '{{prompt}'))).toThrow(/malformed/);
    expect(
      parseManifest(MANIFEST.replace('{{prompt}}', String.raw`{\"a\":{\"p\":{{prompt | json}}}}`)).transport
    ).toBeDefined();
  });

  it('rejects a template that could only fail at launch', () => {
    expect(() => parseManifest(MANIFEST.replace('"run",', '"run", "{{item}}",'))).toThrow(/inside "each"/);
    expect(() => parseManifest(MANIFEST.replace('{{prompt}}', '{{writableDirs}}'))).toThrow(/"each" or a filter/);
    expect(() => parseManifest(MANIFEST.replace('"each": "writableDirs"', '"each": "prompt"'))).toThrow();
  });

  it('rejects a resolver override that would continue its session as a reviewer', () => {
    const resumable = MANIFEST.replace('"stdin"', '"resumeArgs": ["resume", "{{sessionId}}"], "stdin"');
    const withOverride = (override: string): string =>
      resumable.replace('"transport"', `"resolver": ${override}, "transport"`);
    expect(() => parseManifest(withOverride('{ "args": ["run", "--write"] }'))).toThrow(/come together/);
    expect(() => parseManifest(withOverride('{ "resumeArgs": ["resume", "{{sessionId}}", "--write"] }'))).toThrow(
      /come together/
    );
    expect(
      parseManifest(
        withOverride('{ "args": ["run", "--write"], "resumeArgs": ["resume", "{{sessionId}}", "--write"] }')
      ).resolver?.resumeArgs
    ).toHaveLength(3);
  });

  it('refuses a manifest of a newer schema with advice to update', () => {
    expect(() => parseManifest(MANIFEST.replace('"schema": 1', '"schema": 2'))).toThrow(/update the host/);
  });
});

describe('manifestHash', () => {
  it('ignores formatting, comments, key order, and display', async () => {
    const reformatted = JSON.stringify(
      reverseKeys({ ...parseManifest(MANIFEST), display: { name: 'Renamed', description: 'Reworded' } })
    );
    expect(await manifestHash(parseManifest(reformatted))).toBe(await manifestHash(parseManifest(MANIFEST)));
  });

  it('changes when what the host executes changes', async () => {
    const changed = parseManifest(MANIFEST.replace('"run"', '"exec"'));
    expect(await manifestHash(changed)).not.toBe(await manifestHash(parseManifest(MANIFEST)));
  });
});

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((element) => reverseKeys(element));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([key, member]) => [key, reverseKeys(member)])
  );
}

describe('renderArgs', () => {
  const manifest = parseManifest(MANIFEST);
  const args = manifest.transport.args;

  it('adds conditional arguments only for variables that have a value', () => {
    expect(renderArgs(args, { prompt: 'p' })).toEqual(['run']);
    expect(renderArgs(args, { prompt: 'p', model: 'm', effort: 'hi"gh', writableDirs: ['/a', '/b c'] })).toEqual([
      'run',
      '--model',
      'm',
      '-c',
      String.raw`effort="hi\"gh"`,
      '--add-dir',
      '/a',
      '--add-dir',
      '/b c',
    ]);
  });
});

function withFile(path: string): string {
  return MANIFEST.replace('"transport"', `"files": [{ "path": "${path}", "content": "x" }], "transport"`);
}

describe('a path the host acts on', () => {
  it('stays in the scratch directory', () => {
    expect(parseManifest(withFile('{{scratchDir}}/settings.json')).files).toHaveLength(1);
    for (const path of ['settings.json', '/etc/hosts', '{{scratchDir}}/../settings.json', '{{logFile}}']) {
      expect(() => parseManifest(withFile(path))).toThrow(/scratchDir/);
    }
  });
});

describe('a manifest with a usage file', () => {
  const manifest = parseManifest(
    MANIFEST.replace(
      '"usage": { "mode": "delta" },',
      '"usage": { "mode": "delta" }, "usageFile": { "path": "{{scratchDir}}/usage.json", "emit": { "type": "usage", "input": { "from": "/tokens/input" } } },'
    )
  );
  if (manifest.transport.type !== 'jsonl') throw new Error('expected a JSONL transport');
  const { transport } = manifest;
  const DONE = JSON.stringify({ type: 'done', ok: true });
  const typesAndCompleteness = (usageFileText?: string): unknown[] => {
    const mapper = createSessionMapper({ ...manifest, transport }).forProcess();
    return [...mapper.mapLine(DONE), '|', ...mapper.mapUsageFile(usageFileText)].map((event) =>
      typeof event === 'string' ? event : event.type === 'turn_end' ? `turn_end:${event.usageComplete}` : event.type
    );
  };

  it('ends the turn after the usage read from the file', () => {
    expect(typesAndCompleteness('{"tokens":{"input":7}}')).toEqual(['|', 'usage', 'turn_end:true']);
  });

  it('ends the turn with incomplete usage when the file gives none', () => {
    expect(typesAndCompleteness()).toEqual(['|', 'turn_end:false']);
    expect(typesAndCompleteness('not json')).toEqual(['|', 'turn_end:false']);
    expect(typesAndCompleteness('{"tokens":{}}')).toEqual(['|', 'turn_end:false']);
  });
});

describe('a usage rule', () => {
  const manifest = parseManifest(
    MANIFEST.replace(
      '"events": [',
      '"events": [{ "match": { "/type": "done" }, "emit": { "type": "usage", "input": { "from": "/tokens/input" } } },'
    )
  );
  if (manifest.transport.type !== 'jsonl') throw new Error('expected a JSONL transport');
  const { transport } = manifest;
  const map = (line: object): unknown[] =>
    createSessionMapper({ ...manifest, transport })
      .forProcess()
      .mapLine(JSON.stringify({ type: 'done', ok: true, ...line }))
      .map((event) => (event.type === 'turn_end' ? `turn_end:${event.usageComplete}` : event.type));

  it('reports the tokens the harness wrote, zero included', () => {
    expect(map({ tokens: { input: 0 } })).toEqual(['usage', 'turn_end:true']);
  });

  it('reports no usage and an incomplete turn when the line holds none of the declared counts', () => {
    expect(map({ usage: { input: 5 } })).toEqual(['turn_end:false']);
  });

  it('tells the host when the report without counts comes after the end of the turn', () => {
    const mapper = createSessionMapper({ ...manifest, transport }).forProcess();
    expect(mapper.usageUnreported()).toBe(true);
    mapper.mapLine(JSON.stringify({ type: 'done', ok: true, tokens: { input: 1 } }));
    expect(mapper.usageUnreported()).toBe(false);
    mapper.mapLine(JSON.stringify({ type: 'done', ok: false }));
    expect(mapper.usageUnreported()).toBe(true);
  });

  it('does not make a turn incomplete by arriving after the line that ends it', () => {
    const laterUsage = JSON.stringify({
      ...manifest,
      transport: {
        ...transport,
        events: [
          transport.events[1],
          { match: { '/type': 'usage' }, emit: { type: 'usage', input: { from: '/input' } } },
        ],
      },
    });
    const parsed = parseManifest(laterUsage);
    if (parsed.transport.type !== 'jsonl') throw new Error('expected a JSONL transport');
    const mapper = createSessionMapper({ ...parsed, transport: parsed.transport }).forProcess();
    expect(mapper.mapLine(JSON.stringify({ type: 'done', ok: true }))).toMatchObject([{ usageComplete: true }]);
    expect(mapper.usageUnreported()).toBe(true);
    mapper.mapLine(JSON.stringify({ type: 'usage', input: 3 }));
    expect(mapper.usageUnreported()).toBe(false);
  });

  it('is needed for a complete turn', () => {
    const { transport: withoutUsage } = parseManifest(MANIFEST);
    if (withoutUsage.type !== 'jsonl') throw new Error('expected a JSONL transport');
    const [end] = createSessionMapper({ ...manifest, transport: withoutUsage })
      .forProcess()
      .mapLine(JSON.stringify({ type: 'done', ok: true }));
    expect(end).toMatchObject({ type: 'turn_end', usageComplete: false });
  });

  it('cannot be declared beside a usage file', () => {
    const both = JSON.stringify({
      ...manifest,
      transport: {
        ...transport,
        usageFile: { path: '{{scratchDir}}/usage.json', emit: { type: 'usage', input: { from: '/input' } } },
      },
    });
    expect(() => parseManifest(both)).toThrow(/declare one/);
  });
});

function inputOf(mapper: ProcessMapper, total: number): unknown {
  return mapper.mapLine(JSON.stringify({ type: 'usage', input: total }))[0];
}

describe('a harness that reports running totals', () => {
  const manifest = parseManifest(
    MANIFEST.replace(
      '"usage": { "mode": "delta" },',
      '"usage": { "mode": "cumulative" }, "resumeArgs": ["resume", "{{sessionId}}"],'
    ).replace(
      '"events": [',
      '"events": [{ "match": { "/type": "usage" }, "emit": { "type": "usage", "input": { "from": "/input" }, "cacheRead": { "from": "/cache" } } },'
    )
  );
  if (manifest.transport.type !== 'jsonl') throw new Error('expected a JSONL transport');
  const { transport } = manifest;

  it('keeps the running total of a count that a report omits', () => {
    const mapper = createSessionMapper({ ...manifest, transport }).forProcess();
    const cacheReads = [{ input: 100, cache: 50 }, { input: 200 }, { input: 300, cache: 80 }].map(
      (report) => mapper.mapLine(JSON.stringify({ type: 'usage', ...report }))[0]
    );
    expect(cacheReads).toMatchObject([{ cacheRead: 50 }, { cacheRead: 0 }, { cacheRead: 30 }]);
  });

  it('reports each process by its difference from the session so far, or from zero in a new session', () => {
    const session = createSessionMapper({ ...manifest, transport });
    expect(inputOf(session.forProcess(), 1000)).toMatchObject({ input: 1000 });
    expect(inputOf(session.forProcess(), 1500)).toMatchObject({ input: 500 });
    expect(inputOf(session.forProcess(undefined, false), 200)).toMatchObject({ input: 200 });
  });
});
