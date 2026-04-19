import { describe, expect, it } from 'vitest';

import { renderServiceRepairPlan } from './renderServiceRepairPlan';

describe('renderServiceRepairPlan', () => {
  it('includes the repair subcommand in the non-interactive apply guidance', () => {
    const rendered = renderServiceRepairPlan({
      commandPath: 'happier doctor',
      plan: {
        currentReleaseChannel: 'preview',
        existingServices: [],
        actions: [{
          kind: 'install-default-following-service',
          releaseChannel: 'preview',
          mode: 'user',
        }],
        manualWarnings: [],
      },
    });

    expect(rendered).toContain('Run happier doctor repair --yes to apply these actions non-interactively.');
  });

  it('shows manual warnings even when no automatic repair action is available', () => {
    const rendered = renderServiceRepairPlan({
      commandPath: 'happier doctor',
      plan: {
        currentReleaseChannel: 'preview',
        existingServices: [],
        actions: [],
        manualWarnings: [
          'Detected default-following background services with missing Happier home metadata (/home/test/.config/systemd/user/happier-daemon.preview.default.service).',
        ],
      },
    });

    expect(rendered).toContain('No automatic startup repair actions are available.');
    expect(rendered).toContain('Manual cleanup required:');
    expect(rendered).toContain('happier-daemon.preview.default.service');
  });

  it('renders automatic startup, current daemon status, and local relays from the doctor snapshot', () => {
    const rendered = renderServiceRepairPlan({
      commandPath: 'happier doctor',
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [{
          serverId: 'default',
          name: 'Default background service',
          installed: true,
          path: '/tmp/user/.config/systemd/user/happier-daemon.default.service',
          platform: 'linux',
          mode: 'user',
          happierHomeDir: '/tmp/user/.happier',
          releaseChannel: 'stable',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        }],
        actions: [],
        manualWarnings: [],
      },
      snapshot: {
        capturedAt: '2026-04-19T00:00:00.000Z',
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://relay.example.test',
          publicServerUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        },
        accountId: 'acct_123',
        settings: {
          activeServerId: 'cloud',
          servers: [],
          knownAccountIds: ['acct_123'],
        },
        daemonStatus: {
          server: {
            activeServerId: 'cloud',
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
            comparableKey: 'https://relay.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
            httpPort: 7777,
            startedWithCliVersion: '0.0.0-other',
            startedWithPublicReleaseChannel: 'preview',
            startupSource: 'manual',
            serviceManaged: false,
            serviceLabel: null,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine_123',
            needsAuth: false,
            accountId: 'acct_123',
          },
        },
        relays: {
          happier: {
            relays: [
              {
                id: 'dev:user',
                ring: 'dev',
                scope: 'user',
                installed: true,
                version: '0.2.5-dev.7.1',
                relayUrl: 'http://127.0.0.1:4400',
                healthy: true,
                serviceActive: true,
                serviceEnabled: true,
              },
            ],
          },
        },
      },
    });

    expect(rendered).toContain('Automatic startup:');
    expect(rendered).toContain('Default background service');
    expect(rendered).toContain('Daemon:');
    expect(rendered).toContain('relay profile: cloud');
    expect(rendered).toContain('Running now:');
    expect(rendered).toContain('pid 4321');
    expect(rendered).toContain('Started by: manual daemon start');
    expect(rendered).toContain('Running CLI: preview');
    expect(rendered).toContain('0.0.0-other');
    expect(rendered).toContain('Local relay installs:');
    expect(rendered).toContain('http://127.0.0.1:4400');
  });

  it('does not render daemon startup source details when the daemon is not running', () => {
    const rendered = renderServiceRepairPlan({
      commandPath: 'happier doctor',
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      snapshot: {
        capturedAt: '2026-04-19T00:00:00.000Z',
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://relay.example.test',
          publicServerUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        },
        accountId: null,
        settings: {
          activeServerId: 'cloud',
          servers: [],
          knownAccountIds: [],
        },
        daemonStatus: {
          server: {
            activeServerId: 'cloud',
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
            comparableKey: 'https://relay.example.test',
          },
          daemon: {
            running: false,
            pid: null,
            httpPort: null,
            startedWithCliVersion: '0.0.0-other',
            startedWithPublicReleaseChannel: 'preview',
            startupSource: 'manual',
            serviceManaged: false,
            serviceLabel: null,
          },
          service: {
            installed: true,
            running: false,
          },
          auth: {
            authenticated: false,
            machineRegistered: false,
            machineId: null,
            needsAuth: true,
            accountId: null,
          },
        },
      },
    });

    expect(rendered).toContain('Daemon:');
    expect(rendered).toContain('Running now:');
    expect(rendered).toContain('no');
    expect(rendered).not.toContain('Started by:');
    expect(rendered).not.toContain('Running CLI:');
  });
});
