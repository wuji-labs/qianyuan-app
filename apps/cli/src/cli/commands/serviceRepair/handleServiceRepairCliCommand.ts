import chalk from 'chalk';

import { applyBackgroundServiceRepairPlan, buildBackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServiceListEntries } from '@/daemon/service/cli';
import { assertDaemonServiceModeSupported } from '@/daemon/service/assertDaemonServiceModeSupported';

import { isInteractiveTerminal, promptInput } from '../server/commandUtilities';
import { renderServiceRepairPlan } from './renderServiceRepairPlan';

function resolveModeFromText(raw: string, source: string): 'user' | 'system' {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'user' || value === 'system') return value;
  throw new Error(`Invalid ${source} value "${String(raw ?? '').trim()}" (expected user|system)`);
}

function parseRepairInvocation(argv: readonly string[]): Readonly<{
  execute: boolean;
  asJson: boolean;
  mode: 'user' | 'system';
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
    mode: mode ?? (String(process.env.HAPPIER_DAEMON_SERVICE_MODE ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user'),
    systemUser: systemUser || String(process.env.HAPPIER_DAEMON_SERVICE_SYSTEM_USER ?? '').trim(),
  };
}

export async function handleServiceRepairCliCommand(params: Readonly<{
  argv: readonly string[];
  commandPath: string;
}>): Promise<void> {
  const parsed = parseRepairInvocation(params.argv);
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({
    mode: parsed.mode,
    systemUser: parsed.systemUser,
  });
  assertDaemonServiceModeSupported(runtime.platform, parsed.mode);
  if (parsed.mode === 'system' && runtime.platform === 'linux' && runtime.uid !== 0) {
    throw new Error('Root privileges are required for system mode background-service repair');
  }
  const services = await resolveDaemonServiceListEntries(runtime, { mode: parsed.mode });
  const plan = buildBackgroundServiceRepairPlan({
    currentReleaseChannel: runtime.channel,
    services,
  });

  if (parsed.asJson) {
    if (!parsed.execute) {
      console.log(JSON.stringify({
        ok: true,
        executed: false,
        existingServices: plan.existingServices,
        actions: plan.actions,
        manualWarnings: plan.manualWarnings,
      }, null, 2));
      return;
    }

    const result = await applyBackgroundServiceRepairPlan(plan, {
      platform: runtime.platform,
      mode: parsed.mode,
      systemUser: parsed.systemUser,
      uid: runtime.uid,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
    });
    console.log(JSON.stringify({
      ok: true,
      executed: true,
      executedActions: result.executedActions,
      manualWarnings: plan.manualWarnings,
    }, null, 2));
    return;
  }

  if (!parsed.execute) {
    console.log(renderServiceRepairPlan({
      plan,
      commandPath: params.commandPath,
    }));
    if (!isInteractiveTerminal() || plan.actions.length === 0) {
      return;
    }

    const answer = await promptInput('Apply these recommended background-service repair actions now? [Y/n]: ');
    const normalizedAnswer = String(answer ?? '').trim().toLowerCase();
    if (normalizedAnswer !== '' && normalizedAnswer !== 'y' && normalizedAnswer !== 'yes') {
      return;
    }
  }

  const result = await applyBackgroundServiceRepairPlan(plan, {
    platform: runtime.platform,
    mode: parsed.mode,
    systemUser: parsed.systemUser,
    uid: runtime.uid,
    userHomeDir: runtime.userHomeDir,
    happierHomeDir: runtime.happierHomeDir,
  });
  console.log(chalk.green('✓'), `Applied ${result.executedActions.length} background-service repair action(s).`);
}
