import chalk from 'chalk';

import type { DoctorSnapshot } from '@/ui/doctorSnapshot';

type LocalRelay = NonNullable<NonNullable<NonNullable<DoctorSnapshot['relays']>['happier']>['relays'][number]>;

function formatRelayServiceState(relay: LocalRelay): string {
    const parts: string[] = [];
    if (relay.serviceActive === true) {
        parts.push('running');
    } else if (relay.serviceActive === false) {
        parts.push('stopped');
    }
    if (relay.serviceEnabled === true) {
        parts.push('enabled');
    } else if (relay.serviceEnabled === false) {
        parts.push('disabled');
    }
    return parts.join(', ') || 'unknown';
}

function formatRelayHealth(relay: LocalRelay): string {
    if (relay.healthy === true) return 'healthy';
    if (relay.healthy === false) return 'unhealthy';
    return 'unknown';
}

export function formatDoctorLocalRelayLines(relays: readonly LocalRelay[]): string[] {
    if (relays.length === 0) {
        return [`Local server installs: ${chalk.gray('(none)')}`];
    }

    const lines = ['Local server installs:'];
    for (const relay of relays) {
        lines.push(`  - ${relay.ring} (${relay.scope}) → ${relay.relayUrl}`);
        if (relay.version) {
            lines.push(chalk.gray(`      version: ${relay.version}`));
        }
        lines.push(chalk.gray(`      service: ${formatRelayServiceState(relay)}`));
        lines.push(chalk.gray(`      health: ${formatRelayHealth(relay)}`));
        for (const warning of relay.warnings ?? []) {
            lines.push(chalk.yellow(`      warning: ${warning}`));
        }
    }
    return lines;
}
