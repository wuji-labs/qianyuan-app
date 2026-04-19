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
  const lines = [chalk.bold('Local server installs:')];

  if (relays.length === 0) {
    lines.push(chalk.gray('  (none)'));
    return lines;
  }

  for (const relay of relays) {
    lines.push(`  • ${chalk.bold(relay.ring)} ${chalk.gray(`(${relay.scope})`)} ${chalk.gray('→')} ${relay.relayUrl}`);
    if (relay.version) {
      lines.push(chalk.gray(`    - Version: ${relay.version}`));
    }
    lines.push(chalk.gray(`    - Service: ${formatRelayServiceState(relay)}`));
    lines.push(chalk.gray(`    - Health: ${formatRelayHealth(relay)}`));
    for (const warning of relay.warnings ?? []) {
      lines.push(chalk.yellow(`    - Warning: ${warning}`));
    }
  }
  return lines;
}
