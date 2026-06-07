import { describe, expect, it } from 'vitest';

import {
  buildContinuationRecoveryIdentityFromBindings,
  listContinuationRecoveryIdentitiesFromBindings,
} from './continuationRecoveryIdentity';

describe('continuation recovery identity', () => {
  it('builds a group identity from a single changed binding', () => {
    expect(buildContinuationRecoveryIdentityFromBindings({
      serviceIds: new Set(['claude-subscription']),
      bindings: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
            profileId: 'leeroy_new',
          },
        },
      },
      failureFingerprint: 'authentication_failed:401',
      targetGenerationByServiceId: { 'claude-subscription': 18 },
    })).toEqual({
      serviceId: 'claude-subscription',
      selectionKind: 'group',
      groupId: 'claude',
      profileId: 'leeroy_new',
      failureFingerprint: 'authentication_failed:401',
      targetGeneration: 18,
    });
  });

  it('builds a profile identity from a single changed binding', () => {
    expect(buildContinuationRecoveryIdentityFromBindings({
      serviceIds: new Set(['openai-codex']),
      bindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'codex3',
          },
        },
      },
    })).toEqual({
      serviceId: 'openai-codex',
      selectionKind: 'profile',
      profileId: 'codex3',
    });
  });

  it('returns null for native or ambiguous changed bindings', () => {
    expect(buildContinuationRecoveryIdentityFromBindings({
      serviceIds: new Set(['openai-codex']),
      bindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'native' },
        },
      },
    })).toBeNull();

    expect(buildContinuationRecoveryIdentityFromBindings({
      serviceIds: new Set(['openai-codex', 'claude-subscription']),
      bindings: {
        v: 1,
        bindingsByServiceId: {},
      },
    })).toBeNull();
  });

  it('lists identities for all connected profile and group bindings', () => {
    expect(listContinuationRecoveryIdentitiesFromBindings({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'codex',
          profileId: 'codex3',
        },
        'claude-subscription': {
          source: 'connected',
          selection: 'profile',
          profileId: 'leeroy_new',
        },
        github: { source: 'native' },
      },
    })).toEqual([
      {
        serviceId: 'openai-codex',
        selectionKind: 'group',
        groupId: 'codex',
        profileId: 'codex3',
      },
      {
        serviceId: 'claude-subscription',
        selectionKind: 'profile',
        profileId: 'leeroy_new',
      },
    ]);
  });
});
