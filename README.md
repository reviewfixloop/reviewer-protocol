# Reviewer Protocol

The Reviewer Protocol connects a _reviewer_ — a coding-agent harness asked to review a change — to a _host_ that orchestrates reviews. A reviewer always runs as its own process, so it can be written in any language and stays isolated from the host.

A harness connects in one of two ways:

| Kind            | For                   | Connection                                                                                                                                           |
| --------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: CLI wrapper  | an existing harness   | A declarative [manifest](#manifests) tells the host how to launch the vendor's CLI (or its ACP server) and how to map its output to protocol events. |
| B: native agent | a harness you develop | The harness speaks [ACP](https://agentclientprotocol.com) v1 with the [Reviewer Protocol extension](#acp-extension).                                 |

This package holds the protocol's schemas ([zod](https://zod.dev)) and the functions a host and a manifest author share: manifest parsing and hashing, template rendering, and the output mapping.

```sh
npm install reviewer-protocol
```

## Boundary

The host gives a reviewer the checkout's path (its working directory), a task prompt, the revision under review, a time limit, and the model and effort to use. The reviewer returns the [events](#events) below. A session takes several prompts in order (the review, reminders, verification of fixes); a harness that cannot continue a session receives each later prompt, made self-contained, in a new process.

The host decides timeouts, crashes and cancellations itself, since no vendor reports them reliably.

## Events

| `type`     | Fields                                                                                           | Purpose                                   |
| ---------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `session`  | `id`, `harness` (`name`, `version`), `model`                                                     | continuing the session, recording it      |
| `progress` | `kind` (`message`, `thought`, `tool_start`, `tool_end`, `model_call`), `text`                    | the job's log, tool and model call counts |
| `usage`    | `key`, `model`, `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `costUsd`, `servedBy` | usage totals                              |
| `log`      | `level`, `text`                                                                                  | diagnostics kept on the user's machine    |
| `turn_end` | `status`, `stopReason`, `text`, `failure`, `usageComplete`                                       | the result of one prompt                  |

- A turn's usage is complete only when its process reported usage: a turn of a process that produced no `usage` event (the manifest maps none, or the harness died first), or one of whose reports held none of the declared token counts (unreported usage, not zero tokens), ends with `usageComplete: false`. The host decides this once the process has exited, with `ProcessMapper.usageUnreported`: a `turn_end` mapped from a line cannot know what the harness prints after it.
- A process reports its session once, however often the harness names it.
- Token counts have one meaning for every harness: `input` excludes cache reads and writes, `output` includes reasoning, and `reasoning` is the part of `output` spent on reasoning. Each `usage` event is a delta; `key` makes a report delivered twice count once.
- A `model_call` marks one request to the model. A harness whose output does not mark them emits none, so a session without `model_call` has an unknown number of model calls, not zero.
- Tokens are authoritative. `costUsd` is a reference value: few harnesses report it and some estimate it.
- `servedBy` counts the model calls each upstream provider served, by the name the endpoint gave it, for a harness that calls a gateway routing one model to several providers.
- `failure.kind` is one of `authentication`, `quota`, `rate_limit`, `overloaded`, `context_overflow`, `max_output`, `refusal`, `model_not_found`, `transport`, `harness_error`, `unknown`.

## Manifests

A manifest is a JSONC file validated by a schema that rejects unknown keys. It holds no code:

- Templates substitute `{{var}}`, add arguments only when a variable has a value (`{ "when": "model", "args": [...] }`), expand a list (`{ "each": "writableDirs", "args": ["--add-dir", "{{item}}"] }`), and apply the `json` and `toml` filters (`{{writableDirs | toml}}`).
- A path the host acts on (`files`, `usageFile`) starts with `{{scratchDir}}/` and has no `..` segment; the host refuses a rendered path outside the scratch directory.
- Every `{{` opens a placeholder, so a template cannot hold a literal `{{`; `}}` elsewhere is literal text, as in JSON.
- The variables are `prompt`, `model`, `effort`, `sessionId`, `deadlineMinutes`, `logFile`, `scratchDir`, `tmpDir` (the temporary directory of a sandboxed launch), and `writableDirs`.
- Regular expressions must match in linear time: they are compiled with RE2, which has no backreferences or lookaround.
- The output mapping addresses a line's fields with JSON Pointers (RFC 6901).

```jsonc
{
  "schema": 1,
  "id": "example",
  "display": { "name": "Example" }, // shown to people; not part of the identity
  "command": "example", // resolved on PATH: the user's own installation
  "transport": {
    "type": "jsonl",
    "args": ["run", "--json", { "when": "model", "args": ["--model", "{{model}}"] }],
    "resumeArgs": ["run", "--json", "--session", "{{sessionId}}"],
    "stdin": "{{prompt}}",
    "usage": { "mode": "delta" },
    "events": [
      { "match": { "/type": "start" }, "emit": { "type": "session", "id": { "from": "/id" } } },
      {
        "match": { "/type": "done" },
        "emit": {
          "type": "usage",
          "input": { "from": "/tokens/input" },
          "output": { "from": "/tokens/output" },
          "cacheRead": { "from": "/tokens/cached" },
        },
      },
      {
        "match": { "/type": "done" },
        "emit": { "type": "turn_end", "status": "completed", "text": { "from": "/text" } },
      },
    ],
  },
  "failures": [{ "pattern": "(?i)not logged in", "kind": "authentication" }],
}
```

- `usage` declares how the harness counts tokens (`mode: "cumulative"` for running totals of the session, `inputIncludesCacheRead`, `inputIncludesCacheWrite`, `outputIncludesReasoning`), and the host normalizes them to the meaning above. `usageFile` names a JSON file to read the usage from when the output carries none (a manifest declares it or usage rules, not both): the host removes it before each launch, reads it once the process has exited, and reports the turn's `turn_end` after its usage, with `usageComplete: false` when the file is missing, unreadable, or holds none of the declared counts.
- A rule applies to a line that satisfies `match` (every JSON Pointer equals its value, or one of its values) and does not satisfy `unless`; with `each`, it emits one event per element of the named array that satisfies `itemMatch`.
- A process that ends without a mapped `turn_end` ends its turn by its exit status.
- `failures` classify a failure the harness did not classify itself. Each pattern is tried on the failure message followed by the end of standard error, and the match that starts latest decides.
- `"transport": { "type": "acp", ... }` launches the harness's ACP server instead; `"native": true` marks a kind B harness.
- `resolver` overrides the launch for a harness that is asked to fix what the reviewers found.
- `sandbox` lets a host run the harness in a sandbox that confines it to the working copy, its scratch and temporary directories, and the tools on PATH, gives it its own home directory, and lets it reach only the hosts allowed. `passEnv` names the variables of the user's environment passed in unchanged, `signInEnv` the ones passed likewise that the harness signs in with (a host leaves the harness out of a sandboxed run while none is set), both kept in a sandbox even where `env.unset` names them, `setEnv` sets variables in the sandbox alone, and `domains` lists the hosts the harness connects to (`*.` and a domain covers the hosts under it). A host refuses to sandbox a harness whose manifest has no `sandbox`.

A manifest can run arbitrary commands with the user's privileges, so a host shows the resolved arguments, the environment variables it sets and removes, the files it writes, the usage file it removes and reads, and what a sandboxed launch passes in and reaches (`resolveLaunch`) when a manifest is added and whenever its hash changes.

### Identity

`manifestHash` is the SHA-256 of the validated manifest canonicalized by RFC 8785, without `display`. Formatting, comments and display wording never change it.

## ACP extension

A kind B harness is an ACP v1 agent. ACP carries custom data only under `_meta`, so the extension lives under the key `reviewer-protocol/v1`:

| Where                                                  | Content                                                  |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `agentCapabilities._meta` in the `initialize` response | `{ "version": 1 }`: the agent speaks the extension       |
| `_meta` of the `session/new` request                   | `role`, `revision`, `deadlineMinutes`, `model`, `effort` |
| `_meta` of the `session/prompt` response               | `usage`, `usageComplete`, `failure`                      |

The host creates one session per review (`session/new`), sends each prompt with `session/prompt`, and sends `session/cancel` at the time limit. It offers no `fs` or `terminal` capability, passes no MCP servers, and answers every permission request with an allow option: the agent uses its own tools in the checkout. It never calls `authenticate`: the agent signs in with what its user configured beforehand.

`acpMeta` and `readAcpMeta` build and read the extension's `_meta` in an agent written with the [ACP TypeScript SDK](https://www.npmjs.com/package/@agentclientprotocol/sdk):

```ts
import { ACP_META_KEY, acpMeta, acpSessionMetaSchema, readAcpMeta } from 'reviewer-protocol';

// initialize
return { protocolVersion: 1, agentCapabilities: { _meta: acpMeta({ version: 1 }) } };
// session/new
const conditions = readAcpMeta(params._meta, acpSessionMetaSchema);
// session/prompt
return { stopReason: 'end_turn', _meta: acpMeta({ usage: { input: 1200, output: 340, cacheRead: 0 } }) };
```

## Versions and compatibility

The protocol is in beta: the `reviewer-protocol` package on npm has prereleases (`1.0.0-beta.<n>`) under the `beta` dist-tag, and a placeholder under `latest`. Until the first official release, the protocol and the manifest schema change incompatibly without raising their versions. The rules below apply from that release on.

- The protocol and the manifest schema each carry an integer major version (`REVIEWER_PROTOCOL_VERSION`, `MANIFEST_SCHEMA_VERSION`).
- Adding an optional field or a `failure.kind` to the protocol does not raise its major: a host ignores unknown fields and reads an unknown kind as `unknown`.
- The manifest schema rejects unknown keys, so adding a key raises its version. A host refuses a manifest newer than itself and asks to be updated.
- After a new major is released, the previous one stays supported for at least six months.

## License

[Apache-2.0](LICENSE)
