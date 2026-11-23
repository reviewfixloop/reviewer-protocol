import { describe, expect, it } from 'bun:test';

import { manifestHash, parseManifest, renderArgs } from '../../src/index.ts';

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
