import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { buildPosixShellCommand, buildPosixShellEnvironmentAssignments } from '@/utils/posixShellCommand';
import { configuration } from '@/configuration';

function nonEmptyEnvValue(value: string | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

function buildHappierRuntimeContextEnv(): Record<string, string> {
  return {
    HAPPIER_HOME_DIR: configuration.happyHomeDir,
    HAPPIER_ACTIVE_SERVER_ID: configuration.activeServerId,
    HAPPIER_SERVER_URL: nonEmptyEnvValue(process.env.HAPPIER_SERVER_URL) ?? configuration.serverUrl,
    HAPPIER_LOCAL_SERVER_URL: nonEmptyEnvValue(process.env.HAPPIER_LOCAL_SERVER_URL) ?? configuration.apiServerUrl,
    HAPPIER_PUBLIC_SERVER_URL: nonEmptyEnvValue(process.env.HAPPIER_PUBLIC_SERVER_URL) ?? configuration.publicServerUrl,
    HAPPIER_WEBAPP_URL: nonEmptyEnvValue(process.env.HAPPIER_WEBAPP_URL) ?? configuration.webappUrl,
  };
}

export function buildHappierToolsShellBridgeCommand(args: readonly string[]): string {
  const launchSpec = buildHappyCliSubprocessLaunchSpec(['tools', ...args]);
  const command = buildPosixShellCommand([launchSpec.filePath, ...launchSpec.args]);
  const env = {
    ...buildHappierRuntimeContextEnv(),
    ...(launchSpec.env ?? {}),
  };
  return `${buildPosixShellEnvironmentAssignments(env)} ${command}`;
}
