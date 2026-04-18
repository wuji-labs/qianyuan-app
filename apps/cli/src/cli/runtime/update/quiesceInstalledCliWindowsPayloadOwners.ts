import { existsSync } from 'node:fs';

import spawn from 'cross-spawn';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';

import { findAllHappyProcesses, type HappyProcessInfo } from '@/daemon/doctor';

const TERMINATABLE_PROCESS_TYPES = new Set([
  'daemon',
  'dev-daemon',
  'daemon-spawned-session',
  'dev-daemon-spawned',
  'daemon-version-check',
  'dev-daemon-version-check',
] as const);

function normalizeProcessCommand(value: string): string {
  return String(value ?? '').trim().replaceAll('\\', '/').toLowerCase();
}

function resolveManagedCliInvoker(paths: Readonly<{
  binaryPath: string;
  shimPaths: readonly string[];
}>): string | null {
  for (const candidate of [...paths.shimPaths, paths.binaryPath]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isManagedPayloadOwnerProcess(params: Readonly<{
  processInfo: HappyProcessInfo;
  matchNeedles: readonly string[];
}>): boolean {
  if (!TERMINATABLE_PROCESS_TYPES.has(params.processInfo.type as (typeof TERMINATABLE_PROCESS_TYPES extends Set<infer T> ? T : never))) {
    return false;
  }
  const normalizedCommand = normalizeProcessCommand(params.processInfo.command);
  return params.matchNeedles.some((needle) => normalizedCommand.includes(needle));
}

export async function quiesceInstalledCliWindowsPayloadOwners(params: Readonly<{
  channel: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }

  const processEnv = params.processEnv ?? process.env;
  const installedPaths = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    channel: params.channel,
    processEnv,
  });
  const invoker = resolveManagedCliInvoker(installedPaths);

  if (invoker) {
    for (const args of [
      ['service', 'stop', '--json'],
      ['daemon', 'stop', '--all', '--kill-sessions', '--json'],
    ] as const) {
      spawn.sync(invoker, [...args], {
        env: processEnv,
        stdio: 'ignore',
        windowsHide: true,
      });
    }
  }

  const matchNeedles = [
    installedPaths.installRoot,
    installedPaths.currentPath,
    installedPaths.binaryPath,
    ...installedPaths.shimPaths,
  ].map((value) => normalizeProcessCommand(value));

  const matchingProcesses = (await findAllHappyProcesses())
    .filter((processInfo) => processInfo.pid !== process.pid)
    .filter((processInfo) => isManagedPayloadOwnerProcess({
      processInfo,
      matchNeedles,
    }));

  for (const processInfo of matchingProcesses) {
    spawn.sync('taskkill', ['/F', '/T', '/PID', String(processInfo.pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }

  const remainingProcesses = (await findAllHappyProcesses())
    .filter((processInfo) => processInfo.pid !== process.pid)
    .filter((processInfo) => isManagedPayloadOwnerProcess({
      processInfo,
      matchNeedles,
    }));
  if (remainingProcesses.length > 0) {
    throw new Error(
      `Failed to stop running Happier runtime processes before payload promotion: ${remainingProcesses
        .map((processInfo) => `${processInfo.pid}:${processInfo.type}`)
        .join(', ')}`,
    );
  }
}
