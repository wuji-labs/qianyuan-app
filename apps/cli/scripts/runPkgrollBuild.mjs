import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const DEFAULT_PKGROLL_PACKAGE_JSON_FILTER = 'dist/**';

export function resolvePkgrollCliPath() {
  return require.resolve('pkgroll/dist/cli.mjs');
}

export function runPkgrollBuild(options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const cwd = options.cwd ?? process.cwd();
  const packageJsonFilter = options.packageJsonFilter ?? DEFAULT_PKGROLL_PACKAGE_JSON_FILTER;
  const pkgrollCliPath = options.pkgrollCliPath ?? resolvePkgrollCliPath();

  const result = spawn(nodeExecutable, [pkgrollCliPath, '--packagejson', packageJsonFilter], {
    cwd,
    stdio: 'inherit',
  });
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`pkgroll exited with status ${result.status}`);
  }
  if (result.error) {
    throw result.error;
  }
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  return arg.endsWith('/runPkgrollBuild.mjs') || arg.endsWith('\\runPkgrollBuild.mjs');
})();

if (isEntrypoint) {
  runPkgrollBuild();
}
