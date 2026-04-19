import chalk from 'chalk';

import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import type { DoctorSnapshot } from '@/ui/doctorSnapshot';
import { formatDoctorLocalRelayLines } from '@/ui/doctorLocalRelays';
import type { DaemonServiceInventoryEntry } from '@/daemon/service/cli';

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

function dim(text: string): string {
    return chalk.dim(chalk.gray(text));
}

function formatAutomaticStartupLines(params: Readonly<{
    plan: BackgroundServiceRepairPlan;
    inventory?: readonly DaemonServiceInventoryEntry[];
}>): string[] {
    const inventory = params.inventory ?? [];
    const legacyServices = params.plan.existingServices;

    if (inventory.length === 0 && legacyServices.length === 0) {
        return [`${chalk.bold('Automatic startup:')} ${dim('(not enabled yet)')}`];
    }

    const lines = [chalk.bold('Automatic startup:')];
    type AutomaticStartupEntry = Readonly<{
        name: string;
        ring: string;
        serverId: string;
        mode?: string;
        targetMode?: string;
        path: string;
        running?: boolean;
        configuredCliVersion?: string | null;
        runningCliVersion?: string | null;
    }>;
    const entries: readonly AutomaticStartupEntry[] = inventory.length > 0
        ? inventory
        : legacyServices.map((service) => ({
            name: service.name,
            ring: service.releaseChannel,
            serverId: service.serverId,
            mode: service.mode ?? 'user',
            targetMode: service.targetMode,
            path: service.path,
        }));

    for (const service of entries) {
        lines.push(`  • ${chalk.bold(service.name)}`);
        lines.push(dim(`    • Release channel: ${formatReleaseChannel(service.ring)}`));
        if (service.serverId) {
            lines.push(dim(`    • Relay profile: ${service.serverId}`));
        }
        if (service.mode) {
            lines.push(dim(`    • Service scope: ${service.mode}`));
        }
        if (service.targetMode) {
            lines.push(dim(`    • Startup mode: ${formatTargetMode(service.targetMode)}`));
        }
        if (typeof service.running === 'boolean') {
            lines.push(dim(`    • Running now: ${service.running ? chalk.green('yes') : chalk.gray('no')}`));
        }
        if (service.configuredCliVersion) {
            lines.push(dim(`    • Configured CLI version: ${service.configuredCliVersion}`));
        }
        if (service.runningCliVersion) {
            lines.push(dim(`    • Running CLI version: ${service.runningCliVersion}`));
        }
        if (service.path) {
            lines.push(dim(`    • Installed at: ${service.path}`));
        }
    }
    return lines;
}

function formatCurrentDaemonStatusLines(params: Readonly<{
    snapshot: DoctorSnapshot | null;
    daemonCurrentInvocationMatches?: boolean | null;
    currentCliReleaseChannel?: string | null;
    currentCliVersion?: string | null;
}>): string[] {
    const daemonStatus = params.snapshot?.daemonStatus;
    const daemon = daemonStatus?.daemon;
    if (!daemonStatus || !daemon) return [];

    const relayProfile = String(daemonStatus.server.activeServerId ?? '').trim();
    const headerSuffix = relayProfile ? dim(`(relay profile: ${relayProfile})`) : '';
    const lines = [headerSuffix ? `${chalk.bold('Daemon:')} ${headerSuffix}` : chalk.bold('Daemon:')];

	    if (daemon.pid != null) {
	        lines.push(`  • Running now: ${daemon.running ? chalk.green('yes') : chalk.gray('no')} ${dim(`(pid ${daemon.pid})`)}`);
	    } else {
	        lines.push(`  • Running now: ${daemon.running ? chalk.green('yes') : chalk.gray('no')}`);
	    }

	    if (daemon.running !== true) {
	        lines.push(dim('    • Note: multiple daemons can run at once; use `happier daemon status --all` to list other relay profiles.'));
	        return lines;
	    }

	    if (daemon.serviceManaged === true) {
	        lines.push(dim('    • Started by: background service (automatic startup)'));
	    } else if (daemon.serviceManaged === false) {
	        lines.push(dim('    • Started by: manual daemon start'));
	    } else {
	        lines.push(dim('    • Started by: unknown'));
	    }

	    if (daemon.startedWithPublicReleaseChannel || daemon.startedWithCliVersion) {
	        lines.push(dim(`    • Running CLI: ${formatReleaseChannel(daemon.startedWithPublicReleaseChannel ?? 'unknown')} • ${daemon.startedWithCliVersion ?? 'unknown'}`));
	    }
	    lines.push(dim('    • Note: multiple daemons can run at once; use `happier daemon status --all` to list other relay profiles.'));

    if (daemon.running === true && params.daemonCurrentInvocationMatches === false) {
        const currentLabelParts = [
            params.currentCliReleaseChannel ? formatReleaseChannel(params.currentCliReleaseChannel) : null,
            params.currentCliVersion ? params.currentCliVersion : null,
        ].filter(Boolean);
        const currentLabel = currentLabelParts.length > 0 ? currentLabelParts.join(' • ') : null;
        const runningLabelParts = [
            daemon.startedWithPublicReleaseChannel ? formatReleaseChannel(daemon.startedWithPublicReleaseChannel) : null,
            daemon.startedWithCliVersion ? daemon.startedWithCliVersion : null,
        ].filter(Boolean);
        const runningLabel = runningLabelParts.length > 0 ? runningLabelParts.join(' • ') : null;
        const mismatchReason = currentLabel && runningLabel
            ? `This daemon was started by ${runningLabel}, but this CLI is ${currentLabel}.`
            : 'This daemon was started by a different CLI installation than the one you are currently running.';
        lines.push(chalk.yellow(`    • ${mismatchReason}`));
        if (daemon.serviceManaged === true) {
            lines.push(dim('      Tip: run `happier service restart` to restart automatic startup with this installation.'));
        } else {
            lines.push(dim('      Tip: run `happier daemon restart --takeover` to restart this daemon with this installation.'));
        }
    }
    return lines;
}

export function renderServiceRepairRuntimeSummary(params: Readonly<{
    plan: BackgroundServiceRepairPlan;
    snapshot: DoctorSnapshot | null;
    serviceInventory?: readonly DaemonServiceInventoryEntry[];
    daemonCurrentInvocationMatches?: boolean | null;
    currentCliReleaseChannel?: string | null;
    currentCliVersion?: string | null;
}>): string[] {
    const daemonLines = formatCurrentDaemonStatusLines({
        snapshot: params.snapshot,
        daemonCurrentInvocationMatches: params.daemonCurrentInvocationMatches,
        currentCliReleaseChannel: params.currentCliReleaseChannel,
        currentCliVersion: params.currentCliVersion,
    });
    const relays = params.snapshot?.relays?.happier?.relays ?? [];
    const relayLines = relays.length > 0 ? formatDoctorLocalRelayLines(relays) : [];
    const lines = [
        ...formatAutomaticStartupLines({ plan: params.plan, inventory: params.serviceInventory }),
        ...(daemonLines.length > 0 ? ['', ...daemonLines] : []),
        ...(relayLines.length > 0 ? ['', ...relayLines] : []),
    ];

    while (lines.length > 0 && lines.at(-1) === '') {
        lines.pop();
    }

    return lines;
}
