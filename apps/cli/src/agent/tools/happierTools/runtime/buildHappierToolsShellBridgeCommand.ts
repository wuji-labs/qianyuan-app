import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { buildPosixShellCommand, buildPosixShellEnvironmentAssignments } from '@/utils/posixShellCommand';
import { configuration } from '@/configuration';

/**
 * Build the POSIX shell command a shell_bridge provider runs to invoke
 * `happier tools ...`.
 *
 * The authoritative Happier runtime context (active server + server URLs) is made
 * explicit on the coding-agent process at the spawn seam — see
 * `resolveHappierRuntimeContextEnvFromConfiguration` injected in
 * `createCatalogProviderAcpRuntime` — and is inherited by this command and its
 * child CLI process. So this command no longer inlines the full Happier runtime
 * env (which was verbose and POSIX-bound).
 *
 * Two things are still inlined deliberately:
 * - `HAPPIER_HOME_DIR`: defense-in-depth so credential resolution survives even
 *   if a provider's shell tool ever failed to propagate the inherited env. This
 *   can be removed once an authenticated Cursor ACP `change_title` e2e proves
 *   spawn-boundary injection is sufficient on its own.
 * - `launchSpec.env` (e.g. `TSX_TSCONFIG_PATH` in dev): a launch-mechanism detail
 *   of this specific CLI invocation, not session/server context.
 *
 * No secrets are ever embedded.
 */
export function buildHappierToolsShellBridgeCommand(args: readonly string[]): string {
  const launchSpec = buildHappyCliSubprocessLaunchSpec(['tools', ...args]);
  const command = buildPosixShellCommand([launchSpec.filePath, ...launchSpec.args]);

  const inlineEnv: Record<string, string> = {};
  const happyHomeDir = configuration.happyHomeDir?.trim();
  if (happyHomeDir) inlineEnv.HAPPIER_HOME_DIR = happyHomeDir;
  if (launchSpec.env) Object.assign(inlineEnv, launchSpec.env);

  if (Object.keys(inlineEnv).length === 0) return command;
  return `${buildPosixShellEnvironmentAssignments(inlineEnv)} ${command}`;
}
