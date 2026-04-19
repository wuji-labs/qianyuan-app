import chalk from 'chalk';

import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import type { DoctorSnapshot } from '@/ui/doctorSnapshot';
import { formatDoctorLocalRelayLines } from '@/ui/doctorLocalRelays';

function formatTargetMode(targetMode: string): string {
    if (targetMode === 'default-following') {
        return 'follows the selected release channel';
    }
    if (targetMode === 'pinned') {
        return 'pinned to this release channel';
    }
    return targetMode;
}

function formatReleaseChannel(channel: string): string {
    const normalized = String(channel ?? '').trim().toLowerCase();
    if (normalized === 'stable') return chalk.green('stable');
    if (normalized === 'preview') return chalk.yellow('preview');
    if (normalized === 'dev') return chalk.cyan('dev');
    return channel;
}

function formatAutomaticStartupLines(plan: BackgroundServiceRepairPlan): string[] {
    if (plan.existingServices.length === 0) {
        return [`${chalk.bold('Automatic startup:')} ${chalk.gray('(not enabled yet)')}`];
    }

    const lines = [chalk.bold('Automatic startup:')];
    for (const service of plan.existingServices) {
        lines.push(`  • ${chalk.bold(service.name)}`);
        lines.push(chalk.gray(`    - Release channel: ${formatReleaseChannel(service.releaseChannel)}`));
        lines.push(chalk.gray(`    - Relay profile: ${service.serverId}`));
        lines.push(chalk.gray(`    - Service scope: ${service.mode ?? 'user'}`));
        lines.push(chalk.gray(`    - Startup mode: ${formatTargetMode(service.targetMode)}`));
        lines.push(chalk.gray(`    - Installed at: ${service.path}`));
    }
    return lines;
}

function formatCurrentDaemonStatusLines(snapshot: DoctorSnapshot | null): string[] {
    const daemon = snapshot?.daemonStatus?.daemon;
    if (!daemon || daemon.running !== true) return [];

    const lines = [chalk.bold('Running daemon (selected relay):')];

    if (daemon.pid != null) {
        lines.push(`  • Running now: ${chalk.green('yes')} ${chalk.gray(`(pid ${daemon.pid})`)}`);
    } else {
        lines.push(`  • Running now: ${chalk.green('yes')}`);
    }

    if (daemon.serviceManaged === true) {
        lines.push(chalk.gray('    - Started by: background service'));
    } else if (daemon.serviceManaged === false) {
        lines.push(chalk.gray('    - Started by: manual daemon start'));
    } else {
        lines.push(chalk.gray('    - Started by: unknown'));
    }

    if (daemon.startedWithPublicReleaseChannel || daemon.startedWithCliVersion) {
        lines.push(chalk.gray(`    - Running CLI: ${formatReleaseChannel(daemon.startedWithPublicReleaseChannel ?? 'unknown')} • ${daemon.startedWithCliVersion ?? 'unknown'}`));
    }
    lines.push(chalk.gray('    - Note: other daemons may also be running for other relays or home directories.'));
    return lines;
}

export function renderServiceRepairRuntimeSummary(params: Readonly<{
    plan: BackgroundServiceRepairPlan;
    snapshot: DoctorSnapshot | null;
}>): string[] {
    const daemonLines = formatCurrentDaemonStatusLines(params.snapshot);
    const relayLines = formatDoctorLocalRelayLines(params.snapshot?.relays?.happier?.relays ?? []);
    const lines = [
        ...formatAutomaticStartupLines(params.plan),
        ...(daemonLines.length > 0 ? ['', ...daemonLines] : []),
        ...(relayLines.length > 0 ? ['', ...relayLines] : []),
    ];

    while (lines.length > 0 && lines.at(-1) === '') {
        lines.pop();
    }

    return lines;
}
