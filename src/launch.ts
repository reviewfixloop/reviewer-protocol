import type { Manifest, ManifestRole } from './manifest.ts';
import type { TemplateValues } from './template.ts';
import { renderArgs, renderTemplate } from './template.ts';

/** Everything the host does to launch the harness: what a user is shown before trusting a manifest. */
export interface LaunchPlan {
  command: string;
  args: string[];
  /** Text written to standard input, which is then closed. */
  stdin?: string;
  /** No variable is in both. */
  env: { set: Record<string, string>; unset: string[] };
  /** Files written before the launch. */
  files: { path: string; content: string }[];
  /**
   * The JSON file the harness's usage is read from once the process exits. The host removes it
   * before the launch: a process that writes none would otherwise report the file an earlier
   * process of the session left.
   */
  usageFilePath?: string;
  /** What a sandboxed launch lets through; present only when the launch is sandboxed. */
  sandbox?: { passEnv: string[]; domains: string[] };
}

export interface LaunchOptions {
  role: ManifestRole;
  values: TemplateValues;
  platform: 'darwin' | 'linux';
  /** Whether the host runs the harness in its sandbox: the manifest's `sandbox` then applies, and the launch throws without one. */
  sandboxed?: boolean;
}

/**
 * Resolves the manifest's templates into the launch of one process: the one that continues
 * the session `values.sessionId` when the manifest can continue sessions and the id is
 * given, else the one that starts a session. An ACP harness starts one server per session
 * and takes its prompts over the protocol, so its plan carries no prompt.
 */
export function resolveLaunch(manifest: Manifest, options: LaunchOptions): LaunchPlan {
  const { role, values, platform } = options;
  const override = role === 'resolver' ? manifest.resolver : undefined;
  const { transport } = manifest;
  const resumes = transport.type === 'jsonl' && transport.resumeArgs !== undefined && values.sessionId !== undefined;
  const baseArgs = resumes
    ? (override?.resumeArgs ?? (transport.type === 'jsonl' ? transport.resumeArgs : undefined) ?? [])
    : (override?.args ?? transport.args);
  // The override's instruction for a variable replaces the manifest's opposite one.
  const overrideSet = override?.env?.set ?? {};
  const overrideUnset = override?.env?.unset ?? [];
  const sandbox = options.sandboxed === true ? manifest.sandbox : undefined;
  if (options.sandboxed === true && sandbox === undefined) {
    throw new Error(`The manifest "${manifest.id}" declares no "sandbox", so its harness cannot run in a sandbox.`);
  }
  const set = {
    ...Object.fromEntries(Object.entries(manifest.env?.set ?? {}).filter(([name]) => !overrideUnset.includes(name))),
    ...overrideSet,
    ...sandbox?.setEnv,
  };
  return {
    command: manifest.command,
    args: renderArgs([...baseArgs, ...(transport.platformArgs?.[platform] ?? [])], values),
    ...(transport.type === 'jsonl' && transport.stdin !== undefined
      ? { stdin: renderTemplate(transport.stdin, values) }
      : {}),
    env: {
      set: Object.fromEntries(Object.entries(set).map(([name, value]) => [name, renderTemplate(value, values)])),
      unset: [
        ...new Set([
          ...(manifest.env?.unset ?? []).filter((name) => !Object.hasOwn(overrideSet, name)),
          ...overrideUnset,
        ]),
      ].filter(
        (name) =>
          !Object.hasOwn(sandbox?.setEnv ?? {}, name) &&
          !(sandbox?.passEnv ?? []).includes(name) &&
          !(sandbox?.signInEnv ?? []).includes(name)
      ),
    },
    files: (manifest.files ?? []).map((file) => ({
      path: renderTemplate(file.path, values),
      content: renderTemplate(file.content, values),
    })),
    ...(transport.type === 'jsonl' && transport.usageFile !== undefined
      ? { usageFilePath: renderTemplate(transport.usageFile.path, values) }
      : {}),
    ...(sandbox === undefined
      ? {}
      : { sandbox: { passEnv: [...(sandbox.passEnv ?? []), ...(sandbox.signInEnv ?? [])], domains: sandbox.domains } }),
  };
}
