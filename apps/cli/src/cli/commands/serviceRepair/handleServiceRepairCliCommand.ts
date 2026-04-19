import chalk from 'chalk';

import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { renderDaemonServiceRepairOwnershipNote } from '@/daemon/ownership/evaluateServiceLifecycleOwnership';
import { applyBackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import { resolveBackgroundServiceRepairPlanForCurrentRuntime } from '@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime';
import { assertDaemonServiceModeSupported } from '@/daemon/service/assertDaemonServiceModeSupported';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';
import { buildDoctorSnapshot, type DoctorSnapshot } from '@/ui/doctorSnapshot';
import { configuration } from '@/configuration';

import { isInteractiveTerminal, promptInput } from '../server/commandUtilities';
import { assertRepairPlanSystemUserAvailable, resolveBackgroundServiceRepairSystemUser } from './repairSystemUser';
import { renderServiceRepairPlan } from './renderServiceRepairPlan';

function resolveModeFromText(raw: string, source: string): 'user' | 'system' {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'user' || value === 'system') return value;
  throw new Error(`Invalid ${source} value "${String(raw ?? '').trim()}" (expected user|system)`);
}

function parseRepairInvocation(argv: readonly string[]): Readonly<{
  execute: boolean;
  asJson: boolean;
  reportOnly: boolean;
  mode: 'user' | 'system';
  modeExplicit: boolean;
  systemUser: string;
}> {
  let mode: 'user' | 'system' | null = null;
  let systemUser = '';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '');
    if (arg === '--mode') {
      const next = String(argv[index + 1] ?? '');
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --mode (expected user|system)');
      }
      mode = resolveModeFromText(next, '--mode');
      index += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      mode = resolveModeFromText(arg.slice('--mode='.length), '--mode');
      continue;
    }
    if (arg === '--system-user') {
      const next = String(argv[index + 1] ?? '');
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --system-user');
      }
      systemUser = next.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith('--system-user=')) {
      systemUser = arg.slice('--system-user='.length).trim();
    }
  }

  return {
    execute: argv.includes('--yes'),
    asJson: argv.includes('--json'),
    reportOnly: argv.includes('--report-only'),
    mode: mode ?? (String(process.env.HAPPIER_DAEMON_SERVICE_MODE ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user'),
    modeExplicit: mode !== null,
    systemUser: systemUser || String(process.env.HAPPIER_DAEMON_SERVICE_SYSTEM_USER ?? '').trim(),
  };
}

function resolveCurrentPublicReleaseChannelLabel(): string | null {
  const value = String(configuration.publicReleaseRing ?? '').trim();
  if (!value) {
    return null;
  }
  return value === 'publicdev' ? 'dev' : value;
}

function buildDoctorRepairJsonSnapshot(snapshot: DoctorSnapshot | null): Readonly<{
  daemonStatus: DoctorSnapshot['daemonStatus'] | null;
  relays: readonly NonNullable<NonNullable<NonNullable<DoctorSnapshot['relays']>['happier']>['relays'][number]>[];
  daemonRunning: boolean | null;
  daemonPid: number | null;
  daemonServiceManaged: boolean | null;
  daemonStartedWithPublicReleaseChannel: string | null;
  daemonStartedWithCliVersion: string | null;
  daemonCurrentInvocationMatches: boolean | null;
}> {
  const daemon = snapshot?.daemonStatus?.daemon;
  const currentCliVersion = String(configuration.currentCliVersion ?? '').trim();
  const currentPublicReleaseChannel = resolveCurrentPublicReleaseChannelLabel();
  const versionMismatch = Boolean(
    currentCliVersion
    && daemon?.startedWithCliVersion
    && currentCliVersion !== daemon.startedWithCliVersion,
  );
  const releaseChannelMismatch = Boolean(
    currentPublicReleaseChannel
    && daemon?.startedWithPublicReleaseChannel
    && currentPublicReleaseChannel !== daemon.startedWithPublicReleaseChannel,
  );

  return {
    daemonStatus: snapshot?.daemonStatus ?? null,
    relays: snapshot?.relays?.happier?.relays ?? [],
    daemonRunning: typeof daemon?.running === 'boolean' ? daemon.running : null,
    daemonPid: daemon?.pid ?? null,
    daemonServiceManaged: daemon?.serviceManaged ?? null,
    daemonStartedWithPublicReleaseChannel: daemon?.startedWithPublicReleaseChannel ?? null,
    daemonStartedWithCliVersion: daemon?.startedWithCliVersion ?? null,
    daemonCurrentInvocationMatches: daemon?.running
      ? !versionMismatch && !releaseChannelMismatch
      : null,
  };
}

export async function handleServiceRepairCliCommand(params: Readonly<{
  argv: readonly string[];
  commandPath: string;
}>): Promise<void> {
  const parsed = parseRepairInvocation(params.argv);
  const systemUser = resolveBackgroundServiceRepairSystemUser({
    preferredMode: parsed.mode,
    systemUser: parsed.systemUser,
  });
  const runtimePreview = resolveDaemonServiceCliRuntimeFromEnv({
    mode: parsed.mode,
    systemUser,
  });
  const { runtime, plan } = await resolveBackgroundServiceRepairPlanForCurrentRuntime({
    preferredMode: parsed.mode,
    includeAllModes: runtimePreview.platform === 'linux',
    systemUser,
  });
  assertDaemonServiceModeSupported(runtime.platform, parsed.mode);
  if (parsed.modeExplicit && parsed.mode === 'system' && runtime.platform === 'linux' && runtime.uid !== 0) {
    throw new Error('Root privileges are required for system mode background service repair');
  }
  const requiresRootForPlan = runtime.platform === 'linux'
    && runtime.uid !== 0
    && plan.actions.some((action) => action.kind === 'remove-service'
      ? action.service.mode === 'system'
      : action.mode === 'system');
  const ownershipNote = renderDaemonServiceRepairOwnershipNote({
    ownership: await evaluateCurrentDaemonOwner(),
  });
  const ownershipWarningText = ownershipNote
    ? `${ownershipNote.title} ${ownershipNote.lines.join(' ')}`.trim()
    : undefined;
  const snapshot = await buildDoctorSnapshot().catch(() => null);

  if (parsed.asJson) {
    const snapshotJson = buildDoctorRepairJsonSnapshot(snapshot);

    if (!parsed.execute) {
      console.log(JSON.stringify({
        ok: true,
        executed: false,
        existingServices: plan.existingServices,
        actions: plan.actions,
        manualWarnings: plan.manualWarnings,
        warning: ownershipWarningText,
        ...snapshotJson,
      }, null, 2));
      return;
    }

    if (requiresRootForPlan) {
      throw new Error('Root privileges are required to apply system mode background service repair actions');
    }
    assertRepairPlanSystemUserAvailable({
      plan,
      systemUser,
    });

    const result = await applyBackgroundServiceRepairPlan(plan, {
      platform: runtime.platform,
      systemUser,
      uid: runtime.uid,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      nodePath: runtime.nodePath,
      entryPath: runtime.entryPath,
    });
    console.log(JSON.stringify({
      ok: true,
      executed: true,
      executedActions: result.executedActions,
      manualWarnings: plan.manualWarnings,
      warning: ownershipWarningText,
      ...snapshotJson,
    }, null, 2));
    return;
  }

  if (!parsed.execute) {
    console.log(renderServiceRepairPlan({
      plan,
      commandPath: params.commandPath,
      snapshot,
    }));
    if (parsed.reportOnly) {
      return;
    }
    if (ownershipNote) {
      console.log(ownershipNote.title);
      for (const line of ownershipNote.lines) {
        console.log(`  ${line}`);
      }
    }
    if (!isInteractiveTerminal() || plan.actions.length === 0) {
      return;
    }

    const answer = await promptInput('Apply these recommended background service repair actions now? [Y/n]: ');
    const normalizedAnswer = String(answer ?? '').trim().toLowerCase();
    if (normalizedAnswer !== '' && normalizedAnswer !== 'y' && normalizedAnswer !== 'yes') {
      return;
    }
  }

  if (requiresRootForPlan) {
    throw new Error('Root privileges are required to apply system mode background service repair actions');
  }
  assertRepairPlanSystemUserAvailable({
    plan,
    systemUser,
  });

  const result = await applyBackgroundServiceRepairPlan(plan, {
    platform: runtime.platform,
    systemUser,
    uid: runtime.uid,
    userHomeDir: runtime.userHomeDir,
    happierHomeDir: runtime.happierHomeDir,
    nodePath: runtime.nodePath,
    entryPath: runtime.entryPath,
  });
  console.log(chalk.green('✓'), `Applied ${result.executedActions.length} background service repair action(s).`);
  if (ownershipNote) {
    console.log(ownershipNote.title);
    for (const line of ownershipNote.lines) {
      console.log(`  ${line}`);
    }
  }
}
