import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { buildPosixShellCommand, buildPosixShellEnvironmentAssignments } from '@/utils/posixShellCommand';
import { resolveHappierRuntimeContextEnvFromConfiguration } from '@/utils/env/resolveHappierRuntimeContextEnvFromConfiguration';

/**
 * Build the POSIX shell command a shell_bridge provider runs to invoke
 * `happier tools ...`.
 *
 * The resolved Happier runtime context (home dir + active server + server URLs) is
 * inlined into the command. This is REQUIRED, not optional:
 *
 * Cursor's ACP (`cursor-agent acp`) shell tool does NOT propagate the cursor-agent
 * process environment to the shell commands it runs. Verified end-to-end against a
 * live Cursor session: the cursor-agent process itself carries HAPPIER_HOME_DIR
 * (via normal inheritance), yet a `happier tools call change_title` command WITHOUT
 * the context inlined fails with "Not authenticated" (it resolves the default home,
 * not the stack home). Inlining is the only channel that reaches the `happier tools`
 * subprocess for Cursor. (`cursor-agent --print` mode does propagate env, but the
 * ACP subcommand used by Happier does not — do not rely on inheritance here.)
 *
 * Context is resolved via the shared single-source-of-truth helper so this command
 * and the daemon's child-process env never drift, and so the local/public split is
 * expressed consistently. No secrets are ever embedded (the helper emits only the
 * home dir + server selection).
 *
 * `launchSpec.env` (e.g. TSX_TSCONFIG_PATH in dev) is the launch-mechanism env for
 * this specific CLI invocation and is merged after the context.
 */
export function buildHappierToolsShellBridgeCommand(args: readonly string[]): string {
  const launchSpec = buildHappyCliSubprocessLaunchSpec(['tools', ...args]);
  const command = buildPosixShellCommand([launchSpec.filePath, ...launchSpec.args]);
  const env = {
    ...resolveHappierRuntimeContextEnvFromConfiguration(),
    ...(launchSpec.env ?? {}),
  };
  if (Object.keys(env).length === 0) return command;
  return `${buildPosixShellEnvironmentAssignments(env)} ${command}`;
}
