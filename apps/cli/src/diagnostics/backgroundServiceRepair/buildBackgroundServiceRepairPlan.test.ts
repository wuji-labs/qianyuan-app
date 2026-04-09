import { describe, expect, it } from 'vitest';

import { buildBackgroundServiceRepairPlan } from './buildBackgroundServiceRepairPlan';

describe('buildBackgroundServiceRepairPlan', () => {
  it('migrates a pinned current-channel service to one default background service', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'preview',
      services: [{
        serverId: 'company',
        name: 'Company',
        installed: true,
        path: '/tmp/happier-daemon.preview.company.service',
        platform: 'linux',
        releaseChannel: 'preview',
        label: 'happier-daemon.preview.company',
        targetMode: 'pinned',
      }],
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'remove-service',
        service: expect.objectContaining({
          label: 'happier-daemon.preview.company',
          targetMode: 'pinned',
          releaseChannel: 'preview',
        }),
      }),
      expect.objectContaining({
        kind: 'install-default-following-service',
        releaseChannel: 'preview',
      }),
    ]);
  });

  it('keeps one compatible default background service and removes extras', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'stable',
      services: [{
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/tmp/happier-daemon.default.service',
        platform: 'linux',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }, {
        serverId: 'company',
        name: 'Company',
        installed: true,
        path: '/tmp/happier-daemon.company.service',
        platform: 'linux',
        releaseChannel: 'stable',
        label: 'happier-daemon.company',
        targetMode: 'pinned',
      }],
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'remove-service',
        service: expect.objectContaining({
          label: 'happier-daemon.company',
          targetMode: 'pinned',
        }),
      }),
    ]);
  });
});
