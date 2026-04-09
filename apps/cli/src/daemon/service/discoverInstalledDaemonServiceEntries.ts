import * as fs from 'node:fs';
import { basename, join } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { DaemonServiceMode, DaemonServiceTargetMode } from './plan';

export type InstalledDaemonServiceEntry = Readonly<{
  serverId: string;
  name: string;
  installed: true;
  path: string;
  platform: 'darwin' | 'linux' | 'win32';
  releaseChannel: PublicReleaseRingId;
  label: string;
  targetMode: DaemonServiceTargetMode;
}>;

type InstalledServicePathMatch = Readonly<{
  serverId: string;
  releaseChannel: PublicReleaseRingId;
  label: string;
  targetMode: DaemonServiceTargetMode;
}>;

function parseInstalledServicePath(platform: 'darwin' | 'linux' | 'win32', path: string): InstalledServicePathMatch | null {
  const fileName = basename(path);
  const match =
    platform === 'linux'
      ? /^happier-daemon(?:\.(preview|dev))?\.(.+)\.service$/i.exec(fileName)
      : platform === 'darwin'
        ? /^com\.happier\.cli\.daemon(?:\.(preview|dev))?\.(.+)\.plist$/i.exec(fileName)
        : /^happier-daemon(?:\.(preview|dev))?\.(.+)\.ps1$/i.exec(fileName);
  if (!match) {
    return null;
  }
  const channelSegment = String(match[1] ?? '').trim().toLowerCase();
  const serverId = String(match[2] ?? '').trim();
  if (!serverId) {
    return null;
  }
  const releaseChannel = channelSegment === 'preview'
    ? 'preview'
    : channelSegment === 'dev'
      ? 'publicdev'
      : 'stable';
  const targetMode: DaemonServiceTargetMode = serverId === 'default' ? 'default-following' : 'pinned';
  const label = platform === 'win32'
    ? `Happier\\${basename(path, '.ps1')}`
    : platform === 'darwin'
      ? basename(path, '.plist')
      : basename(path, '.service');
  return { serverId, releaseChannel, label, targetMode };
}

function normalizeParsedReleaseChannel(value: string | null): PublicReleaseRingId | null {
  if (value === 'preview') return 'preview';
  if (value === 'dev') return 'publicdev';
  if (value === 'stable') return 'stable';
  return null;
}

function readInstalledServiceFile(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseLinuxUnitValue(contents: string, key: string): string | null {
  const match = new RegExp(`Environment=${key}=([^\\n\\r]+)`, 'i').exec(contents);
  return String(match?.[1] ?? '').trim() || null;
}

function parseDarwinPlistValue(contents: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, 'i').exec(contents);
  return String(match?.[1] ?? '').trim() || null;
}

function parseWindowsWrapperValue(contents: string, key: string): string | null {
  const match = new RegExp(`\\$env:${key}\\s*=\\s*['"]([^'"]+)['"]`, 'i').exec(contents);
  return String(match?.[1] ?? '').trim() || null;
}

function parseInstalledServiceMetadata(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  initialReleaseChannel: PublicReleaseRingId;
  initialTargetMode: DaemonServiceTargetMode;
}>): Readonly<{
  releaseChannel: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
}> {
  const contents = readInstalledServiceFile(params.path);
  if (!contents) {
    return {
      releaseChannel: params.initialReleaseChannel,
      targetMode: params.initialTargetMode,
    };
  }

  const readValue =
    params.platform === 'linux'
      ? (key: string) => parseLinuxUnitValue(contents, key)
      : params.platform === 'darwin'
        ? (key: string) => parseDarwinPlistValue(contents, key)
        : (key: string) => parseWindowsWrapperValue(contents, key);

  const parsedTargetMode = readValue('HAPPIER_DAEMON_SERVICE_TARGET_MODE');
  const parsedReleaseChannel = normalizeParsedReleaseChannel(readValue('HAPPIER_PUBLIC_RELEASE_CHANNEL'));
  return {
    releaseChannel: parsedReleaseChannel ?? params.initialReleaseChannel,
    targetMode: parsedTargetMode === 'default-following' ? 'default-following' : params.initialTargetMode,
  };
}

export async function discoverInstalledDaemonServiceEntries(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  userHomeDir: string;
  happierHomeDir: string;
  mode: DaemonServiceMode;
  serversById: Readonly<Record<string, unknown>>;
}>): Promise<readonly InstalledDaemonServiceEntry[]> {
  const servicesDir =
    params.platform === 'linux'
      ? params.mode === 'system'
        ? join('/etc', 'systemd', 'system')
        : join(params.userHomeDir, '.config', 'systemd', 'user')
      : params.platform === 'darwin'
        ? join(params.userHomeDir, 'Library', 'LaunchAgents')
        : join(params.happierHomeDir, 'services');

  let fileNames: string[] = [];
  try {
    fileNames = fs.readdirSync(servicesDir);
  } catch {
    return [];
  }

  return fileNames
    .map((fileName) => join(servicesDir, fileName))
    .flatMap((path) => {
      const parsed = parseInstalledServicePath(params.platform, path);
      if (!parsed) {
        return [];
      }
      const metadata = parseInstalledServiceMetadata({
        platform: params.platform,
        path,
        initialReleaseChannel: parsed.releaseChannel,
        initialTargetMode: parsed.targetMode,
      });
      const profile = params.serversById[parsed.serverId];
      const name = metadata.targetMode === 'default-following'
        ? 'Default background service'
        : typeof profile === 'object' && profile && !Array.isArray(profile) && typeof (profile as { name?: unknown }).name === 'string'
          ? String((profile as { name: string }).name).trim() || parsed.serverId
          : parsed.serverId;
      return [{
        serverId: parsed.serverId,
        name,
        installed: true as const,
        path,
        platform: params.platform,
        releaseChannel: metadata.releaseChannel,
        label: parsed.label,
        targetMode: metadata.targetMode,
      }];
    });
}
