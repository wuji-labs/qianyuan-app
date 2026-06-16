import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export function resolveTypeScriptCliPath({ cwd = process.cwd(), requireResolver } = {}) {
  const baseDir = resolve(cwd);
  if (typeof requireResolver === 'function') {
    return requireResolver('typescript/bin/tsc', { paths: [baseDir] });
  }
  const require = createRequire(import.meta.url);
  return require.resolve('typescript/bin/tsc', { paths: [baseDir] });
}

export function resolveTypeScriptCommandInvocation({
  cwd = process.cwd(),
  args = [],
  processExecPath = process.execPath,
  requireResolver,
} = {}) {
  return {
    command: processExecPath,
    args: [
      resolveTypeScriptCliPath({ cwd, requireResolver }),
      ...args,
    ],
  };
}
