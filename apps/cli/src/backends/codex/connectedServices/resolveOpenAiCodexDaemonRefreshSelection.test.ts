import { describe, expect, it } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  createOpenAiCodexBridgeRefreshFailureClassification,
  resolveOpenAiCodexDaemonRefreshSelection,
} from './resolveOpenAiCodexDaemonRefreshSelection';

describe('resolveOpenAiCodexDaemonRefreshSelection', () => {
  it('uses current session metadata before stale child env selection', () => {
    const resolution = resolveOpenAiCodexDaemonRefreshSelection({
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        fallbackProfileId: 'backup',
        generation: 7,
      }]),
    }, {
      getMetadataSnapshot: () => ({
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'main',
              profileId: 'backup',
            },
          },
        },
      }),
    });

    expect(resolution).toEqual({
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'backup',
      },
      recoveryGroupId: 'main',
    });
    expect(createOpenAiCodexBridgeRefreshFailureClassification(resolution!)).toMatchObject({
      kind: 'refresh_failed',
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'main',
    });
  });

  it('falls back to child env when session metadata has no connected binding', () => {
    expect(resolveOpenAiCodexDaemonRefreshSelection({
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        fallbackProfileId: 'backup',
        generation: 7,
      }]),
    }, {
      getMetadataSnapshot: () => ({ connectedServices: null }),
    })).toEqual({
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        fallbackProfileId: 'backup',
        generation: 7,
      },
      recoveryGroupId: 'main',
    });
  });

  it('falls back to child env when session metadata preserves only the group id', () => {
    expect(resolveOpenAiCodexDaemonRefreshSelection({
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        fallbackProfileId: 'backup',
        generation: 7,
      }]),
    }, {
      getMetadataSnapshot: () => ({
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'main',
            },
          },
        },
      }),
    })).toEqual({
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        fallbackProfileId: 'backup',
        generation: 7,
      },
      recoveryGroupId: 'main',
    });
  });
});
