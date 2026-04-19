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

function formatAutomaticStartupLines(plan: BackgroundServiceRepairPlan): string[] {
    if (plan.existingServices.length === 0) {
        return [`Automatic startup: ${chalk.gray('(no background services installed)')}`];
    }

    const lines = ['Automatic startup:'];
    for (const service of plan.existingServices) {
        lines.push(`  - ${service.name}`);
        lines.push(chalk.gray(`      release channel: ${service.releaseChannel}`));
        lines.push(chalk.gray(`      relay profile: ${service.serverId}`));
        lines.push(chalk.gray(`      service scope: ${service.mode ?? 'user'}`));
        lines.push(chalk.gray(`      startup mode: ${formatTargetMode(service.targetMode)}`));
        lines.push(chalk.gray(`      installed at: ${service.path}`));
    }
    return lines;
}

function formatCurrentDaemonStatusLines(snapshot: DoctorSnapshot | null): string[] {
    const daemon = snapshot?.daemonStatus?.daemon;
    if (!daemon) {
        return [`Current daemon status: ${chalk.gray('(unavailable)')}`];
    }

    const lines = ['Current daemon status:'];
    if (daemon.running !== true) {
        lines.push('  - No daemon is currently running on this computer.');
        return lines;
    }

    if (daemon.pid != null) {
        lines.push(`  - Running now: yes (pid ${daemon.pid})`);
    } else {
        lines.push('  - Running now: yes');
    }

    if (daemon.serviceManaged === true) {
        lines.push('  - Started by: background service');
    } else if (daemon.serviceManaged === false) {
        lines.push('  - Started by: manual daemon start');
    } else {
        lines.push('  - Started by: unknown');
    }

    if (daemon.startedWithPublicReleaseChannel || daemon.startedWithCliVersion) {
        lines.push(`  - Running CLI: ${daemon.startedWithPublicReleaseChannel ?? 'unknown'} • ${daemon.startedWithCliVersion ?? 'unknown'}`);
    }
    return lines;
}

export function renderServiceRepairRuntimeSummary(params: Readonly<{
    plan: BackgroundServiceRepairPlan;
    snapshot: DoctorSnapshot | null;
}>): string[] {
    const lines = [
        ...formatAutomaticStartupLines(params.plan),
        '',
        ...formatCurrentDaemonStatusLines(params.snapshot),
        '',
        ...formatDoctorLocalRelayLines(params.snapshot?.relays?.happier?.relays ?? []),
    ];

    while (lines.length > 0 && lines.at(-1) === '') {
        lines.pop();
    }

    return lines;
}
