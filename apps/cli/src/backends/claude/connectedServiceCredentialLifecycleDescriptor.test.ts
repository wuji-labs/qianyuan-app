import { describe, expect, it } from 'vitest';

import { agent } from './index';

describe('Claude connected-service credential lifecycle descriptor', () => {
  it('does not advertise predictive live soft switching without real in-process account adoption', async () => {
    await expect(agent.getConnectedServiceCredentialLifecycleDescriptor()).resolves.toMatchObject({
      providerId: 'claude',
      serviceIds: expect.arrayContaining(['claude-subscription', 'anthropic']),
      spawnPreflightOauthRefresh: { mode: 'force' },
      refreshedCredentialApplication: { mode: 'restart_required' },
      sameAccountFanoutStrategy: 'shared_group_auth_surface',
      predictiveSoftSwitch: {
        mode: 'unsupported',
        liveSessionRequirement: { kind: 'none' },
      },
    });
  });
});
