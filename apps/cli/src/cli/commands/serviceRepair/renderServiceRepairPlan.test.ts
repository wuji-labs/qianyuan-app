import { describe, expect, it } from 'vitest';

import { renderServiceRepairPlan } from './renderServiceRepairPlan';

describe('renderServiceRepairPlan', () => {
  it('includes the repair subcommand in the non-interactive apply guidance', () => {
    const rendered = renderServiceRepairPlan({
      commandPath: 'happier service',
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

    expect(rendered).toContain('Run happier service repair --yes to apply these actions non-interactively.');
  });

  it('shows manual warnings even when no automatic repair action is available', () => {
    const rendered = renderServiceRepairPlan({
      commandPath: 'happier service',
      plan: {
        currentReleaseChannel: 'preview',
        existingServices: [],
        actions: [],
        manualWarnings: [
          'Detected default-following background services with missing Happier home metadata (/home/test/.config/systemd/user/happier-daemon.preview.default.service).',
        ],
      },
    });

    expect(rendered).toContain('No automatic background-service repair actions are available.');
    expect(rendered).toContain('Manual cleanup required:');
    expect(rendered).toContain('happier-daemon.preview.default.service');
  });
});
