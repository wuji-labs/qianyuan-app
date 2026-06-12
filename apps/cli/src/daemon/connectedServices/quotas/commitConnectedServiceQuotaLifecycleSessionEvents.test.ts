import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const PLAIN_SESSION_RESPONSE = {
  status: 200,
  data: {
    session: {
      id: 'sess-1',
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      encryptionMode: 'plain',
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
    },
  },
} as const;

const COMMIT_RESPONSE = {
  status: 200,
  data: {
    didWrite: true,
    message: { id: 'msg-1', seq: 2, localId: 'local-1', createdAt: 2 },
  },
} as const;

const CREDENTIALS = {
  token: 'token-1',
  encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
} as const;

describe('commitConnectedServiceQuotaLifecycleSessionEvents', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('commits a provider-quota-wait transcript event per blocked group-bound session with the known reset timing', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceQuotaLifecycleSessionEvents } = await import('./commitConnectedServiceQuotaLifecycleSessionEvents');

    vi.spyOn(axios, 'get').mockResolvedValue(PLAIN_SESSION_RESPONSE);
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue(COMMIT_RESPONSE);

    await commitConnectedServiceQuotaLifecycleSessionEvents({
      credentials: CREDENTIALS,
      transition: {
        phase: 'blocked',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        sessionIds: ['sess-1', 'sess-2'],
        issueFingerprint: 'quota-blocked:openai-codex:main',
        resetAtMs: 1_900_000,
        reason: 'connected_service_group_quota_exhausted',
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(2);
    const payload = postSpy.mock.calls[0]?.[1] as Readonly<{ content: { t: string; v: { content: { data: unknown } } } }>;
    expect(payload.content.t).toBe('plain');
    expect(payload.content.v.content.data).toMatchObject({
      type: 'provider-quota-wait',
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      resetAtMs: 1_900_000,
      reason: 'connected_service_group_quota_exhausted',
    });
  });

  it('skips the wait transcript event when the blocked transition has no reset timing', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceQuotaLifecycleSessionEvents } = await import('./commitConnectedServiceQuotaLifecycleSessionEvents');

    vi.spyOn(axios, 'get').mockResolvedValue(PLAIN_SESSION_RESPONSE);
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue(COMMIT_RESPONSE);

    await commitConnectedServiceQuotaLifecycleSessionEvents({
      credentials: CREDENTIALS,
      transition: {
        phase: 'blocked',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        sessionIds: ['sess-1'],
        issueFingerprint: 'quota-blocked:openai-codex:main',
        resetAtMs: null,
        reason: 'connected_service_group_quota_exhausted',
      },
    });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('commits a provider-quota-recovered transcript event per session on the recovered edge', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceQuotaLifecycleSessionEvents } = await import('./commitConnectedServiceQuotaLifecycleSessionEvents');

    vi.spyOn(axios, 'get').mockResolvedValue(PLAIN_SESSION_RESPONSE);
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue(COMMIT_RESPONSE);

    await commitConnectedServiceQuotaLifecycleSessionEvents({
      credentials: CREDENTIALS,
      transition: {
        phase: 'recovered',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        sessionIds: ['sess-1'],
        issueFingerprint: 'quota-blocked:openai-codex:main',
        resetAtMs: null,
        reason: 'fresh_quota_evidence',
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    const payload = postSpy.mock.calls[0]?.[1] as Readonly<{ content: { t: string; v: { content: { data: unknown } } } }>;
    expect(payload.content.v.content.data).toMatchObject({
      type: 'provider-quota-recovered',
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      reason: 'fresh_quota_evidence',
    });
  });

  it('keeps committing remaining sessions when one session commit fails', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceQuotaLifecycleSessionEvents } = await import('./commitConnectedServiceQuotaLifecycleSessionEvents');

    vi.spyOn(axios, 'get').mockResolvedValue(PLAIN_SESSION_RESPONSE);
    const postSpy = vi.spyOn(axios, 'post')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(COMMIT_RESPONSE);

    await commitConnectedServiceQuotaLifecycleSessionEvents({
      credentials: CREDENTIALS,
      transition: {
        phase: 'recovered',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: null,
        sessionIds: ['sess-1', 'sess-2'],
        issueFingerprint: 'quota-blocked:openai-codex:main',
        resetAtMs: null,
        reason: 'fresh_quota_evidence',
      },
    });

    expect(postSpy).toHaveBeenCalledTimes(2);
  });
});
