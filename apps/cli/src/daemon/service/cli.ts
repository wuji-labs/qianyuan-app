import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { configuration } from '@/configuration';
import { readDaemonState, readSettings } from '@/persistence';
import { isBun } from '@/utils/runtime';
import { resolveJavaScriptRuntimeExecutable } from '@/runtime/js/resolveJavaScriptRuntimeExecutable';

import { installDaemonService, uninstallDaemonService } from './installer';
import {
  planDaemonServiceInstall,
  planDaemonServiceLifecycle,
  planDaemonServiceUninstall,
  resolveLaunchAgentPlistPath,
  resolveSystemdUserUnitPath,
  resolveSystemdSystemUnitPath,
  resolveWindowsDaemonWrapperPath,
  resolveWindowsDaemonTaskName,
  resolveDaemonServiceLaunchdLabel,
  resolveDaemonServiceSystemdUnitName,
  resolveDaemonServiceChannelSegment,
  type DaemonServiceMode,
  type DaemonServiceTargetMode,
} from './plan';
import { commandExistsInPath } from './commandExistsInPath';
import { resolveDaemonServiceRuntimeTarget } from './runtimeTarget';
import { resolveDaemonServiceInstallRuntimeTarget } from './resolveDaemonServiceInstallRuntimeTarget';
import { resolveLinuxSystemUserPaths } from './resolveLinuxSystemUserPaths';
import { inferPublicReleaseRingIdFromEnvAndArgv } from '@/cli/runtime/publicReleaseChannel';
import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { expandHomeDirPath } from '@happier-dev/cli-common/providers';

import { discoverInstalledDaemonServiceEntries } from './discoverInstalledDaemonServiceEntries';
import type { DaemonServiceInstallStrategy } from './daemonInstallConflict';
import { assertDaemonServiceModeSupported } from './assertDaemonServiceModeSupported';

export type DaemonServiceCliAction =
  | 'list'
  | 'paths'
  | 'install'
  | 'uninstall'
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'logs'
  | 'tail';

type SupportedPlatform = 'darwin' | 'linux' | 'win32';

function resolveSupportedPlatform(p: string): SupportedPlatform | null {
  const normalized = (p ?? '').toString().trim().toLowerCase();
  if (normalized === 'darwin' || normalized === 'mac' || normalized === 'macos' || normalized === 'osx') return 'darwin';
  if (normalized === 'linux') return 'linux';
  if (normalized === 'win32' || normalized === 'windows' || normalized === 'win') return 'win32';
  return null;
}

function resolvePlatformFromProcess(): SupportedPlatform | null {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  return null;
}

function parseCliFlags(argv: readonly string[]): Readonly<{ json: boolean; dryRun: boolean; help: boolean }> {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  return {
    json: flags.has('--json'),
    dryRun: flags.has('--dry-run') || flags.has('--plan'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

function resolveModeFromText(raw: string, source: string): DaemonServiceMode {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'user' || value === 'system') return value;
  throw new Error(`Invalid ${source} value "${String(raw ?? '').trim()}" (expected user|system)`);
}

function resolveOptionalModeFromText(raw: string, source: string): DaemonServiceMode | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  return resolveModeFromText(value, source);
}

function parseDaemonServiceCliInvocation(argv: readonly string[]): Readonly<{
  argvFiltered: string[];
  flags: Readonly<{
    json: boolean;
    dryRun: boolean;
    help: boolean;
    yes: boolean;
    replaceExisting: 'ring' | 'all' | null;
    ring: PublicReleaseRingId | null;
    instanceId: string | null;
  }>;
  action: DaemonServiceCliAction;
  mode: DaemonServiceMode;
  systemUser: string;
}> {
  const filtered: string[] = [];
  let modeFromArgs: DaemonServiceMode | null = null;
  let systemUserFromArgs: string | null = null;
  let yes = false;
  let replaceExisting: 'ring' | 'all' | null = null;
  let ring: PublicReleaseRingId | null = null;
  let instanceId: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');

    if (a === '--mode') {
      const next = String(argv[i + 1] ?? '');
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --mode (expected user|system)');
      }
      modeFromArgs = resolveModeFromText(next, '--mode');
      i += 1;
      continue;
    }
    if (a.startsWith('--mode=')) {
      modeFromArgs = resolveModeFromText(a.slice('--mode='.length), '--mode');
      continue;
    }
    if (a === '--system') {
      modeFromArgs = 'system';
      continue;
    }
    if (a === '--user') {
      modeFromArgs = 'user';
      continue;
    }
    if (a === '--yes' || a === '-y' || a === '--allow-multiple') {
      yes = true;
      continue;
    }
    if (a === '--ring') {
      const next = String(argv[i + 1] ?? '').trim().toLowerCase();
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --ring (expected stable|preview|dev)');
      }
      if (next === 'stable') ring = 'stable';
      else if (next === 'preview') ring = 'preview';
      else if (next === 'dev') ring = 'publicdev';
      else throw new Error(`Invalid --ring value "${next}" (expected stable|preview|dev)`);
      i += 1;
      continue;
    }
    if (a.startsWith('--ring=')) {
      const value = a.slice('--ring='.length).trim().toLowerCase();
      if (value === 'stable') ring = 'stable';
      else if (value === 'preview') ring = 'preview';
      else if (value === 'dev') ring = 'publicdev';
      else throw new Error(`Invalid --ring value "${value}" (expected stable|preview|dev)`);
      continue;
    }
    if (a === '--instance') {
      const next = String(argv[i + 1] ?? '').trim();
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --instance');
      }
      instanceId = next;
      i += 1;
      continue;
    }
    if (a.startsWith('--instance=')) {
      instanceId = a.slice('--instance='.length).trim() || null;
      continue;
    }
    if (a === '--replace-existing') {
      const next = String(argv[i + 1] ?? '').trim().toLowerCase();
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --replace-existing (expected ring|all)');
      }
      if (next !== 'ring' && next !== 'all') {
        throw new Error(`Invalid --replace-existing value "${next}" (expected ring|all)`);
      }
      replaceExisting = next;
      i += 1;
      continue;
    }
    if (a.startsWith('--replace-existing=')) {
      const value = a.slice('--replace-existing='.length).trim().toLowerCase();
      if (value !== 'ring' && value !== 'all') {
        throw new Error(`Invalid --replace-existing value "${value}" (expected ring|all)`);
      }
      replaceExisting = value;
      continue;
    }

    if (a === '--system-user') {
      const next = String(argv[i + 1] ?? '');
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --system-user');
      }
      systemUserFromArgs = next.trim();
      i += 1;
      continue;
    }
    if (a.startsWith('--system-user=')) {
      systemUserFromArgs = a.slice('--system-user='.length).trim();
      continue;
    }

    filtered.push(a);
  }

  const flags = parseCliFlags(filtered);
  if (replaceExisting && !yes) {
    throw new Error('--replace-existing requires --yes');
  }
  const action = resolveAction(filtered);
  const mode = modeFromArgs ?? resolveOptionalModeFromText(process.env.HAPPIER_DAEMON_SERVICE_MODE ?? '', 'HAPPIER_DAEMON_SERVICE_MODE') ?? 'user';
  const systemUser = systemUserFromArgs ?? String(process.env.HAPPIER_DAEMON_SERVICE_SYSTEM_USER ?? '').trim();

  return { argvFiltered: filtered, flags: { ...flags, yes, replaceExisting, ring, instanceId }, action, mode, systemUser };
}

function resolveAction(argv: readonly string[]): DaemonServiceCliAction {
  const positionals = argv.filter((a) => a && a !== '--' && !a.startsWith('-'));
  const action = (positionals[0] ?? 'status').toString().trim();
  if (!action) return 'status';
  if (action === 'help') return 'status';
  return action as DaemonServiceCliAction;
}

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function runCommandCaptureBestEffort(command: Readonly<{ cmd: string; args: readonly string[] }>): { ok: boolean; out: string | null } {
  try {
    const res = spawnSync(command.cmd, [...command.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const ok = (res.status ?? 1) === 0;
    const out = (res.stdout ? String(res.stdout) : '') + (res.stderr ? String(res.stderr) : '');
    return { ok, out: out.trim() ? out : null };
  } catch {
    return { ok: false, out: null };
  }
}

function runCommandsBestEffort(commands: ReadonlyArray<Readonly<{ cmd: string; args: readonly string[] }>>): void {
  for (const command of commands) {
    if (!commandExistsInPath({ cmd: command.cmd, envPath: process.env.PATH, platform: process.platform, pathext: process.env.PATHEXT })) continue;
    try {
      spawnSync(command.cmd, [...command.args], { stdio: 'ignore', env: process.env });
    } catch {
      // ignore
    }
  }
}

export type DaemonServiceCliRuntime = Readonly<{
  platform: SupportedPlatform;
  channel: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
  instanceId: string;
  uid: number | null;
  userHomeDir: string;
  happierHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  publicServerUrl: string;
  nodePath: string;
  entryPath: string;
}>;

function resolveDaemonServiceTargetModeFromText(raw: string | null | undefined): DaemonServiceTargetMode {
  return String(raw ?? '').trim().toLowerCase() === 'default-following' ? 'default-following' : 'pinned';
}

function resolveDaemonServiceServerTargets(processEnv: NodeJS.ProcessEnv): Readonly<{
  serverUrl: string;
  publicServerUrl: string;
  webappUrl: string;
}> {
  const explicitServerUrl = String(processEnv.HAPPIER_SERVER_URL ?? '').trim();
  const explicitLocalServerUrl = String(processEnv.HAPPIER_LOCAL_SERVER_URL ?? '').trim();
  const explicitPublicServerUrl = String(processEnv.HAPPIER_PUBLIC_SERVER_URL ?? '').trim();
  const explicitWebappUrl = String(processEnv.HAPPIER_WEBAPP_URL ?? '').trim();

  if (explicitPublicServerUrl || explicitServerUrl) {
    const publicServerUrl = explicitPublicServerUrl || explicitServerUrl;
    const serverUrl = explicitLocalServerUrl || (explicitPublicServerUrl ? explicitServerUrl : '') || publicServerUrl;
    return {
      serverUrl,
      publicServerUrl,
      webappUrl: explicitWebappUrl || configuration.webappUrl,
    };
  }

  return {
    serverUrl: configuration.apiServerUrl,
    publicServerUrl: configuration.serverUrl,
    webappUrl: configuration.webappUrl,
  };
}

export function resolveDaemonServiceCliRuntimeFromEnv(options: Readonly<{
  mode?: DaemonServiceMode;
  systemUser?: string;
  channel?: PublicReleaseRingId | null;
  targetMode?: DaemonServiceTargetMode | null;
  instanceId?: string | null;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): DaemonServiceCliRuntime {
  const processEnv = options.processEnv ?? process.env;
  const channel = options.channel ||
    normalizePublicReleaseRingId(String(processEnv.HAPPIER_DAEMON_SERVICE_CHANNEL ?? '').trim()) ||
    inferPublicReleaseRingIdFromEnvAndArgv({ env: processEnv, argv: process.argv });
  const platform =
    resolveSupportedPlatform(processEnv.HAPPIER_DAEMON_SERVICE_PLATFORM ?? '') ??
    resolvePlatformFromProcess();
  if (!platform) {
    throw new Error('Daemon service is currently only supported on macOS, Linux, and Windows');
  }

  const uidEnvRaw = (processEnv.HAPPIER_DAEMON_SERVICE_UID ?? '').trim();
  const uidEnv = uidEnvRaw ? Number(uidEnvRaw) : null;
  const uidFromProc = process.getuid ? process.getuid() : null;
  const uid = uidEnv !== null && Number.isFinite(uidEnv) && uidEnv >= 0 ? uidEnv : uidFromProc;

  const explicitUserHomeDir = expandHomeDirPath((processEnv.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR ?? '').trim(), processEnv);
  const explicitHappierHomeDir = expandHomeDirPath((processEnv.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR ?? '').trim(), processEnv);
  const systemUserPaths =
    platform === 'linux' && options.mode === 'system' && String(options.systemUser ?? '').trim()
      ? resolveLinuxSystemUserPaths({
          systemUser: String(options.systemUser ?? '').trim(),
          userHomeDirOverride: explicitUserHomeDir,
          happierHomeDirOverride: explicitHappierHomeDir,
        })
      : null;

  let resolvedRealHomeDir = '';
  try {
    resolvedRealHomeDir = String(os.userInfo()?.homedir ?? '').trim();
  } catch {
    resolvedRealHomeDir = '';
  }
  const userHomeDir = systemUserPaths?.userHomeDir ?? (explicitUserHomeDir || resolvedRealHomeDir || os.homedir());
  const happierHomeDir = systemUserPaths?.happierHomeDir ?? (explicitHappierHomeDir || configuration.happyHomeDir);
  const targetMode = options.targetMode ?? resolveDaemonServiceTargetModeFromText(processEnv.HAPPIER_DAEMON_SERVICE_TARGET_MODE || 'default-following');
  const instanceId = String(options.instanceId ?? '').trim() || (processEnv.HAPPIER_DAEMON_SERVICE_INSTANCE_ID ?? '').trim() || configuration.activeServerId;
  const resolvedServerTargets = resolveDaemonServiceServerTargets(processEnv);
  const serverUrl = (processEnv.HAPPIER_DAEMON_SERVICE_SERVER_URL ?? '').trim() || resolvedServerTargets.serverUrl;
  const webappUrl = (processEnv.HAPPIER_DAEMON_SERVICE_WEBAPP_URL ?? '').trim() || resolvedServerTargets.webappUrl;
  const publicServerUrl = (processEnv.HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL ?? '').trim() || resolvedServerTargets.publicServerUrl;
  const explicitNodePath = (processEnv.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? '').trim();
  const explicitEntryPath = (processEnv.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? '').trim();
  const runtimeTarget = resolveDaemonServiceRuntimeTarget({
    currentExecPath: process.execPath,
    runtimeExecutable: explicitNodePath
      ? null
      : resolveJavaScriptRuntimeExecutable({
          isBunRuntime: isBun(),
          processEnv,
        }),
    explicitNodePath,
    explicitEntryPath,
  });

  return {
    platform,
    channel,
    targetMode,
    instanceId,
    uid,
    userHomeDir,
    happierHomeDir,
    serverUrl,
    webappUrl,
    publicServerUrl,
    nodePath: runtimeTarget.nodePath,
    entryPath: runtimeTarget.entryPath,
  };
}

export type DaemonServiceInstallationSnapshot = Readonly<{
  platform: SupportedPlatform;
  installed: boolean;
  installedPath: string;
}>;

export type DaemonServiceListEntry = Readonly<{
  serverId: string;
  name: string;
  installed: boolean;
  path: string;
  platform: SupportedPlatform;
  releaseChannel: PublicReleaseRingId;
  label: string;
  targetMode: DaemonServiceTargetMode;
}>;

export type DaemonServiceInventoryEntry = Readonly<{
  serviceType: 'daemon';
  label: string;
  ring: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
  installed: boolean;
  running: boolean;
}>;

export function resolveDaemonServiceInstallationSnapshotFromEnv(options: Readonly<{
  mode?: DaemonServiceMode;
  systemUser?: string;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): DaemonServiceInstallationSnapshot {
  const runtime = resolveDaemonServiceCliRuntimeFromEnv(options);
  const paths = resolveDaemonServicePaths(runtime, { mode: options.mode });
  return {
    platform: runtime.platform,
    installed: fs.existsSync(paths.installedPath),
    installedPath: paths.installedPath,
  };
}

export function resolveDaemonServicePaths(
  runtime: DaemonServiceCliRuntime,
  options: Readonly<{ mode?: DaemonServiceMode }> = {},
): Readonly<{
  platform: SupportedPlatform;
  label: string;
  unitName: string;
  plistPath: string;
  unitPath: string;
  wrapperPath: string;
  taskName: string;
  installedPath: string;
  stdoutPath: string;
  stderrPath: string;
}> {
  const mode: DaemonServiceMode = options.mode === 'system' ? 'system' : 'user';
  const logPrefix = runtime.targetMode === 'default-following'
    ? ''
    : (() => {
        const channelSegment = resolveDaemonServiceChannelSegment(runtime.channel);
        return channelSegment ? `${channelSegment}.` : '';
      })();
  const logInstanceId = runtime.targetMode === 'default-following' ? 'default' : runtime.instanceId;
  const label = resolveDaemonServiceLaunchdLabel(runtime.instanceId, runtime.channel, runtime.targetMode);
  const unitName = resolveDaemonServiceSystemdUnitName(runtime.instanceId, runtime.channel, runtime.targetMode);
  const plistPath = resolveLaunchAgentPlistPath({
    userHomeDir: runtime.userHomeDir,
    instanceId: runtime.instanceId,
    channel: runtime.channel,
    targetMode: runtime.targetMode,
  });
  const unitPath =
    runtime.platform === 'linux' && mode === 'system'
      ? resolveSystemdSystemUnitPath({ instanceId: runtime.instanceId, channel: runtime.channel, targetMode: runtime.targetMode })
      : resolveSystemdUserUnitPath({
          userHomeDir: runtime.userHomeDir,
          instanceId: runtime.instanceId,
          channel: runtime.channel,
          targetMode: runtime.targetMode,
        });
  const wrapperPath = runtime.platform === 'win32'
    ? resolveWindowsDaemonWrapperPath({
        happierHomeDir: runtime.happierHomeDir,
        instanceId: runtime.instanceId,
        channel: runtime.channel,
        targetMode: runtime.targetMode,
      })
    : '';
  const taskName = runtime.platform === 'win32'
    ? resolveWindowsDaemonTaskName({ instanceId: runtime.instanceId, channel: runtime.channel, targetMode: runtime.targetMode })
    : '';
  const installedPath = runtime.platform === 'darwin'
    ? plistPath
    : runtime.platform === 'linux'
      ? unitPath
      : wrapperPath;
  return {
    platform: runtime.platform,
    label,
    unitName,
    plistPath,
    unitPath,
    wrapperPath,
    taskName,
    installedPath,
    stdoutPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.out.log`),
    stderrPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.err.log`),
  };
}

export async function resolveDaemonServiceListEntries(
  runtime: DaemonServiceCliRuntime,
  options: Readonly<{ mode?: DaemonServiceMode }> = {},
): Promise<readonly DaemonServiceListEntry[]> {
  const settings = await readSettings();
  return await discoverInstalledDaemonServiceEntries({
    platform: runtime.platform,
    userHomeDir: runtime.userHomeDir,
    happierHomeDir: runtime.happierHomeDir,
    mode: options.mode === 'system' ? 'system' : 'user',
    serversById: (settings.servers ?? {}) as Readonly<Record<string, unknown>>,
  });
}

function mapDaemonServiceListEntriesToInventory(entries: readonly DaemonServiceListEntry[]): readonly DaemonServiceInventoryEntry[] {
  return entries.map((entry) => ({
    serviceType: 'daemon',
    label: entry.label,
    ring: entry.releaseChannel,
    targetMode: entry.targetMode,
    installed: entry.installed,
    running: false,
  }));
}

export async function runDaemonServiceCliCommand(params: Readonly<{ argv: readonly string[] }>): Promise<void> {
  const parsed = parseDaemonServiceCliInvocation(params.argv);
  const flags = parsed.flags;
  const mode = parsed.mode;
  const systemUser = parsed.systemUser;
  const targetMode: DaemonServiceTargetMode =
    flags.ring || flags.instanceId
      ? 'pinned'
      : resolveDaemonServiceTargetModeFromText(process.env.HAPPIER_DAEMON_SERVICE_TARGET_MODE || 'default-following');
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({
    mode,
    systemUser,
    channel: flags.ring,
    targetMode,
    instanceId: flags.instanceId,
  });
  if (!flags.help) {
    assertDaemonServiceModeSupported(runtime.platform, mode);
  }
  const paths = resolveDaemonServicePaths(runtime, { mode });
  const action = parsed.action;

  if (flags.help) {
      if (flags.json) {
        printJson({
          ok: true,
          commands: ['list', 'paths', 'install', 'uninstall', 'repair', 'start', 'stop', 'restart', 'status', 'logs', 'tail'],
          flags: ['--json', '--dry-run', '--yes', '--replace-existing=ring|all', '--ring', '--instance', '--all'],
        });
        return;
    }
    process.stdout.write(
      [
        'happier service',
        '',
        'Usage:',
        '  happier service list [--json]',
        '  happier service paths [--json]',
        '  happier service status [--json]',
        '  happier service install [--dry-run] [--yes] [--replace-existing=ring|all] [--json]',
        '  happier service uninstall [--ring <stable|preview|dev>] [--instance <id>] [--all] [--yes] [--dry-run] [--json]',
        '  happier service repair [--yes] [--json]',
        '  happier service start|stop|restart [--dry-run] [--json]',
        '  happier service logs [--json]',
        '  happier service tail',
        '',
        'Compatibility aliases:',
        '  happier daemon service ...',
        '',
      ].join('\n'),
    );
    return;
  }

  if (action === 'list') {
    const entries = await resolveDaemonServiceListEntries(runtime, { mode });
    if (flags.json) {
      printJson({ entries, services: mapDaemonServiceListEntriesToInventory(entries) });
      return;
    }

    if (entries.length === 0) {
      process.stdout.write('(no background services installed)\n');
      return;
    }

    for (const entry of entries) {
      process.stdout.write(`${entry.name} (${entry.serverId}, ${entry.releaseChannel})\n`);
      process.stdout.write(`  ${entry.installed ? 'installed' : 'not installed'}: ${entry.path}\n`);
    }
    return;
  }

  if (action === 'paths') {
    if (flags.json) {
      printJson({
        ok: true,
        platform: runtime.platform,
        paths: runtime.platform === 'darwin'
          ? { plistPath: paths.plistPath, label: paths.label, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath }
          : runtime.platform === 'win32'
            ? { taskName: paths.taskName, wrapperPath: paths.wrapperPath, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath }
            : { unitPath: paths.unitPath, unitName: paths.unitName, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath },
      });
      return;
    }

    process.stdout.write(
      runtime.platform === 'darwin'
        ? `LaunchAgent: ${paths.plistPath}\nLabel: ${paths.label}\n`
        : runtime.platform === 'win32'
          ? `Scheduled Task: ${paths.taskName}\nWrapper: ${paths.wrapperPath}\n`
          : `systemd unit: ${paths.unitPath}\nUnit name: ${paths.unitName}\n`,
    );
    process.stdout.write(`stdout: ${paths.stdoutPath}\nstderr: ${paths.stderrPath}\n`);
    return;
  }

  if (action === 'install') {
    if (runtime.platform === 'linux' && mode === 'system') {
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Root privileges are required for system mode service install');
      }
      if (!systemUser) {
        throw new Error('Missing --system-user (required for system mode)');
      }
    }

    const installRuntimeTarget = await resolveDaemonServiceInstallRuntimeTarget({
      currentExecPath: process.execPath,
      explicitNodePath: process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? '',
      explicitEntryPath: process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? '',
      targetMode: runtime.targetMode,
      processEnv: process.env,
    });
    const installRuntime = {
      ...runtime,
      nodePath: installRuntimeTarget.nodePath,
      entryPath: installRuntimeTarget.entryPath,
    };

    const plan = planDaemonServiceInstall({
      platform: installRuntime.platform,
      mode,
      systemUser,
      channel: installRuntime.channel,
      targetMode: installRuntime.targetMode,
      instanceId: installRuntime.instanceId,
      uid: installRuntime.uid ?? undefined,
      userHomeDir: installRuntime.userHomeDir,
      happierHomeDir: installRuntime.happierHomeDir,
      serverUrl: installRuntime.serverUrl,
      webappUrl: installRuntime.webappUrl,
      publicServerUrl: installRuntime.publicServerUrl,
      nodePath: installRuntime.nodePath,
      entryPath: installRuntime.entryPath,
    });

    if (flags.dryRun) {
      if (flags.json) {
        printJson({ ok: true, platform: installRuntime.platform, plan });
        return;
      }
      process.stdout.write(`[dry-run] would write: ${plan.files.map((f) => f.path).join(', ')}\n`);
      for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      return;
    }

    const strategy: DaemonServiceInstallStrategy | undefined =
      flags.replaceExisting === 'ring' ? 'replace-ring'
      : flags.replaceExisting === 'all' ? 'replace-all'
      : flags.yes ? 'add'
      : undefined;

    try {
      await installDaemonService({
        platform: installRuntime.platform,
        uid: installRuntime.uid ?? undefined,
        userHomeDir: installRuntime.userHomeDir,
        happierHomeDir: installRuntime.happierHomeDir,
        mode,
        systemUser,
        channel: installRuntime.channel,
        targetMode: installRuntime.targetMode,
        instanceId: installRuntime.instanceId,
        serverUrl: installRuntime.serverUrl,
        webappUrl: installRuntime.webappUrl,
        publicServerUrl: installRuntime.publicServerUrl,
        nodePath: installRuntime.nodePath,
        entryPath: installRuntime.entryPath,
        strategy,
        runCommands: true,
      });
    } catch (error) {
      const conflict = error as Error & { code?: string; conflicts?: Array<{ label?: string }> };
      if (flags.json && conflict.code === 'daemon_service_conflict') {
        printJson({
          ok: false,
          error: conflict.code,
          message: conflict.message,
          conflicts: conflict.conflicts ?? [],
          platform: installRuntime.platform,
        });
        return;
      }
      throw error;
    }

    if (flags.json) {
      printJson({ ok: true, platform: installRuntime.platform });
      return;
    }
    process.stdout.write('Background service installed.\n');
    return;
  }

  if (action === 'uninstall') {
    if (runtime.platform === 'linux' && mode === 'system') {
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Root privileges are required for system mode service uninstall');
      }
    }

    const wantsAll = parsed.argvFiltered.includes('--all');
    const confirmed = flags.yes;
    if (wantsAll) {
      const entries = await resolveDaemonServiceListEntries(runtime, { mode });
      const plans = entries.map((entry) => planDaemonServiceUninstall({
        platform: runtime.platform,
        mode,
        channel: entry.releaseChannel,
        targetMode: entry.targetMode,
        instanceId: entry.serverId,
        uid: runtime.uid ?? undefined,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
      }));

      if (flags.dryRun || !confirmed) {
        if (flags.json) {
          printJson({ ok: true, platform: runtime.platform, removed: entries.length, plans });
          return;
        }
        for (const plan of plans) {
          process.stdout.write(`[dry-run] would remove: ${plan.filesToRemove.join(', ')}\n`);
          for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
        }
        return;
      }

      for (const entry of entries) {
        await uninstallDaemonService({
          platform: runtime.platform,
          uid: runtime.uid ?? undefined,
          userHomeDir: runtime.userHomeDir,
          happierHomeDir: runtime.happierHomeDir,
          mode,
          channel: entry.releaseChannel,
          targetMode: entry.targetMode,
          instanceId: entry.serverId,
          runCommands: true,
        });
      }

      if (flags.json) {
        printJson({ ok: true, platform: runtime.platform, removed: entries.length });
        return;
      }
      process.stdout.write(`Removed ${entries.length} background services.\n`);
      return;
    }

    const plan = planDaemonServiceUninstall({
      platform: runtime.platform,
      mode,
      channel: runtime.channel,
      targetMode: runtime.targetMode,
      instanceId: runtime.instanceId,
      uid: runtime.uid ?? undefined,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
    });

    if (flags.dryRun) {
      if (flags.json) {
        printJson({ ok: true, platform: runtime.platform, plan });
        return;
      }
      process.stdout.write(`[dry-run] would remove: ${plan.filesToRemove.join(', ')}\n`);
      for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      return;
    }

    await uninstallDaemonService({
      platform: runtime.platform,
      uid: runtime.uid ?? undefined,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      mode,
      channel: runtime.channel,
      targetMode: runtime.targetMode,
      instanceId: runtime.instanceId,
      runCommands: true,
    });

    if (flags.json) {
      printJson({ ok: true, platform: runtime.platform });
      return;
    }
    process.stdout.write('Background service uninstalled.\n');
    return;
  }

  if (action === 'start' || action === 'stop' || action === 'restart') {
    if (runtime.platform === 'linux' && mode === 'system') {
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Root privileges are required for system mode service lifecycle actions');
      }
    }

    if (!fs.existsSync(paths.installedPath)) {
      const msg = `Background service is not installed (${paths.installedPath}). Run: happier service install`;
      if (flags.json) printJson({ ok: false, error: 'not_installed', message: msg, platform: runtime.platform });
      else process.stderr.write(`${msg}\n`);
      return;
    }

    const plan = planDaemonServiceLifecycle({
      platform: runtime.platform,
      action,
      mode,
      channel: runtime.channel,
      targetMode: runtime.targetMode,
      instanceId: runtime.instanceId,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      uid: runtime.uid ?? undefined,
    });

    if (flags.dryRun) {
      if (flags.json) {
        printJson({ ok: true, platform: runtime.platform, plan });
        return;
      }
      for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      return;
    }

    runCommandsBestEffort(plan.commands);

    if (flags.json) {
      printJson({ ok: true, platform: runtime.platform });
      return;
    }
    process.stdout.write(`Background service ${action} requested.\n`);
    return;
  }

  if (action === 'status') {
    const installed = fs.existsSync(paths.installedPath);

    const state = await readDaemonState().catch(() => null);
    const pid = typeof state?.pid === 'number' ? state.pid : null;
    const pidAlive = (() => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();

    const systemPlan = planDaemonServiceLifecycle({
      platform: runtime.platform,
      action: 'status',
      mode,
      channel: runtime.channel,
      targetMode: runtime.targetMode,
      instanceId: runtime.instanceId,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      uid: runtime.uid ?? undefined,
    });

    const systemStatus = installed && !flags.dryRun && systemPlan.commands.length
      ? runCommandCaptureBestEffort(systemPlan.commands[0]!)
      : { ok: false, out: null };

    if (flags.json) {
      printJson({
        ok: true,
        platform: runtime.platform,
        installed,
        installedPath: paths.installedPath,
        daemon: pid ? { pid, running: pidAlive, startedAt: state?.startedAt ?? null } : { pid: null, running: false, startedAt: null },
        system: { ok: systemStatus.ok, output: systemStatus.out },
      });
      return;
    }

    process.stdout.write(installed ? 'Service: installed\n' : 'Service: not installed\n');
    process.stdout.write(pidAlive ? `Background service: running (pid ${pid})\n` : 'Background service: not running\n');
    if (systemStatus.out) process.stdout.write(`\n${systemStatus.out}\n`);
    return;
  }

  if (action === 'logs') {
    if (flags.json) {
      printJson({ ok: true, platform: runtime.platform, logs: { stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath } });
      return;
    }
    process.stdout.write(`${paths.stdoutPath}\n${paths.stderrPath}\n`);
    return;
  }

  if (action === 'tail') {
    if (flags.json) {
      printJson({ ok: false, error: 'not_supported', message: 'tail is interactive; omit --json', platform: runtime.platform });
      return;
    }
    if (runtime.platform === 'win32') {
      process.stderr.write('tail is not supported on Windows yet. Use: happier service logs\n');
      return;
    }
    // Best-effort: follow both stdout + stderr if tail exists.
    if (!commandExistsInPath({ cmd: 'tail', envPath: process.env.PATH, platform: process.platform, pathext: process.env.PATHEXT })) {
      process.stderr.write('tail not found on PATH\n');
      return;
    }
    spawnSync('tail', ['-n', '200', '-f', paths.stdoutPath, paths.stderrPath], { stdio: 'inherit', env: process.env });
    return;
  }

  const msg = `Unknown background service subcommand: ${action}`;
  if (flags.json) printJson({ ok: false, error: 'invalid_subcommand', message: msg });
  else process.stderr.write(`${msg}\n`);
}
